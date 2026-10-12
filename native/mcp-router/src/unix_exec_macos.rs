use super::{cstring, wait};
use std::{ffi::CString, path::Path};

const CS_VALID: u32 = 0x1;
const CS_HARD: u32 = 0x100;
const CS_KILL: u32 = 0x200;
const CS_DEBUGGED: u32 = 0x10000000;
const CS_EXEC_SET_HARD: u32 = 0x100000;
const CS_EXEC_SET_KILL: u32 = 0x200000;

extern "C" {
    fn csops(
        pid: libc::pid_t,
        operation: u32,
        address: *mut libc::c_void,
        size: usize,
    ) -> libc::c_int;
}

pub(super) struct Executable {
    path: CString,
    hashes: Vec<[u8; 20]>,
}

pub(super) fn ensure_single_thread() -> Result<(), String> {
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    if unsafe {
        libc::proc_pidinfo(
            libc::getpid(),
            libc::PROC_PIDTASKINFO,
            0,
            (&mut info as *mut libc::proc_taskinfo).cast(),
            size,
        )
    } != size
        || info.pti_threadnum != 1
    {
        return Err("Unix MCP execution requires a single-threaded headless router.".into());
    }
    Ok(())
}

impl Executable {
    pub(super) fn prepare(path: &Path, bytes: &[u8]) -> Result<Self, String> {
        Ok(Self {
            path: cstring(path.as_os_str())?,
            hashes: crate::macho_identity::cdhashes(bytes)?,
        })
    }

    pub(super) fn spawn(
        &self,
        argv: &[*mut libc::c_char],
        envp: &[*mut libc::c_char],
        source: i32,
    ) -> Result<libc::pid_t, String> {
        let mut attr: libc::posix_spawnattr_t = unsafe { std::mem::zeroed() };
        let mut actions: libc::posix_spawn_file_actions_t = unsafe { std::mem::zeroed() };
        if unsafe { libc::posix_spawnattr_init(&mut attr) } != 0 {
            return Err("Cannot prepare suspended MCP execution.".into());
        }
        if unsafe { libc::posix_spawn_file_actions_init(&mut actions) } != 0 {
            unsafe {
                libc::posix_spawnattr_destroy(&mut attr);
            }
            return Err("Cannot prepare private MCP streams.".into());
        }
        let result = (|| {
            let flags = libc::POSIX_SPAWN_START_SUSPENDED
                | libc::POSIX_SPAWN_SETPGROUP
                | libc::POSIX_SPAWN_CLOEXEC_DEFAULT
                | libc::POSIX_SPAWN_SETSIGMASK;
            let mut mask: libc::sigset_t = unsafe { std::mem::zeroed() };
            unsafe {
                libc::sigemptyset(&mut mask);
            }
            if unsafe { libc::posix_spawnattr_setflags(&mut attr, flags as i16) } != 0
                || unsafe { libc::posix_spawnattr_setpgroup(&mut attr, 0) } != 0
                || unsafe { libc::posix_spawnattr_setsigmask(&mut attr, &mask) } != 0
                || unsafe { libc::posix_spawn_file_actions_adddup2(&mut actions, source, 3) } != 0
            {
                return Err("Cannot enforce suspended MCP process ownership.".into());
            }
            for fd in 0..=2 {
                if unsafe { libc::posix_spawn_file_actions_adddup2(&mut actions, fd, fd) } != 0 {
                    return Err("Cannot inherit MCP stdio.".into());
                }
            }
            let mut pid = 0;
            if unsafe {
                libc::posix_spawn(
                    &mut pid,
                    self.path.as_ptr(),
                    &actions,
                    &attr,
                    argv.as_ptr(),
                    envp.as_ptr(),
                )
            } != 0
            {
                return Err("macOS refused suspended MCP execution.".into());
            }
            // START_SUSPENDED precedes user-space execution. Kernel queries are
            // against the child's loaded vnode, never a reopened pathname.
            let checked = verify_child(pid, &self.hashes);
            if checked.is_err() || unsafe { libc::kill(pid, libc::SIGCONT) } != 0 {
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                    libc::kill(pid, libc::SIGKILL);
                }
                let _ = wait(pid);
                return Err("Suspended MCP image did not match the verified CodeDirectory/enforcement flags.".into());
            }
            Ok(pid)
        })();
        unsafe {
            libc::posix_spawn_file_actions_destroy(&mut actions);
            libc::posix_spawnattr_destroy(&mut attr);
        }
        result
    }
}

fn verify_child(pid: libc::pid_t, hashes: &[[u8; 20]]) -> Result<(), String> {
    let mut flags = 0u32;
    let mut hash = [0u8; 20];
    if unsafe { csops(pid, 0, (&mut flags as *mut u32).cast(), 4) } != 0
        || unsafe { csops(pid, 5, hash.as_mut_ptr().cast(), hash.len()) } != 0
        || flags & (CS_VALID | CS_HARD | CS_KILL) != CS_VALID | CS_HARD | CS_KILL
        || flags & CS_DEBUGGED != 0
        || !hashes.contains(&hash)
    {
        return Err("macOS loaded executable identity is unverified.".into());
    }
    Ok(())
}

pub(super) fn prepare_supervisor() -> Result<(), String> {
    // XNU restricts marking someone else's process to root. The private
    // supervisor instead requests inherited hard/kill flags on its own exec.
    // Failure (including an unsigned Intel router) refuses before spawn.
    let mut flags = CS_EXEC_SET_HARD | CS_EXEC_SET_KILL;
    if unsafe { csops(0, 9, (&mut flags as *mut u32).cast(), 4) } != 0 {
        return Err("macOS could not require inherited MCP code-page enforcement.".into());
    }
    Ok(())
}

pub(super) fn cleanup_adopted() -> Result<(), String> {
    // macOS has no Linux subreaper contract. Process-group cleanup is real but
    // does not claim containment of a helper deliberately escaping via setsid.
    Ok(())
}
