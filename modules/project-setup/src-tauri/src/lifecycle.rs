use std::sync::Mutex;

pub static LIFECYCLE: Lifecycle = Lifecycle::new();

struct State {
    active: u32,
    closing: bool,
    window: Option<usize>,
}
pub struct Lifecycle(Mutex<State>);
pub struct Guard<'a>(&'a Lifecycle);

impl Lifecycle {
    pub const fn new() -> Self {
        Self(Mutex::new(State {
            active: 0,
            closing: false,
            window: None,
        }))
    }
    pub fn command(&self) -> Result<Guard<'_>, String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Setup lifecycle state is unavailable.")?;
        if state.closing {
            return Err("Setup is closing. No new operation was started.".into());
        }
        state.active = state
            .active
            .checked_add(1)
            .ok_or("Too many active operations.")?;
        state.publish();
        Ok(Guard(self))
    }
    pub fn request_close(&self) -> bool {
        let Ok(mut state) = self.0.lock() else {
            return false;
        };
        if state.active != 0 {
            return false;
        }
        state.closing = true;
        state.publish();
        true
    }
    #[cfg(windows)]
    pub fn attach(&self, window: usize) {
        if let Ok(mut state) = self.0.lock() {
            state.window = Some(window);
            state.publish();
        }
    }
    pub fn detach(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.window = None;
        }
    }
}
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0 .0.lock() {
            state.active -= 1;
            state.publish();
        }
    }
}
impl State {
    fn publish(&self) {
        #[cfg(windows)]
        if let Some(window) = self.window {
            use windows_sys::Win32::UI::WindowsAndMessaging::{RemovePropW, SetPropW};
            unsafe {
                if SetPropW(
                    window as _,
                    windows_sys::w!("CreatorSuite.LauncherBusy"),
                    usize::from(self.active != 0) as _,
                ) != 0
                    && SetPropW(
                        window as _,
                        windows_sys::w!("CreatorSuite.Closing"),
                        usize::from(self.closing) as _,
                    ) != 0
                {
                    SetPropW(
                        window as _,
                        windows_sys::w!("CreatorSuite.LifecycleProtocol"),
                        1usize as _,
                    );
                } else {
                    RemovePropW(
                        window as _,
                        windows_sys::w!("CreatorSuite.LifecycleProtocol"),
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn close_waits_for_all_operations_and_rejects_new_ones() {
        let life = Lifecycle::new();
        let first = life.command().unwrap();
        let second = life.command().unwrap();
        assert!(!life.request_close());
        drop(first);
        assert!(!life.request_close());
        drop(second);
        assert!(life.request_close());
        assert!(life.command().is_err());
    }
    #[test]
    fn close_and_new_operation_cannot_both_win() {
        for _ in 0..64 {
            let life = std::sync::Arc::new(Lifecycle::new());
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let l = life.clone();
            let b = barrier.clone();
            let worker = std::thread::spawn(move || {
                b.wait();
                let guard = l.command();
                b.wait();
                guard.is_ok()
            });
            barrier.wait();
            let closed = life.request_close();
            barrier.wait();
            let started = worker.join().unwrap();
            assert!(!(closed && started));
        }
    }
    #[test]
    fn async_mutations_move_the_guard_into_the_worker() {
        let source = include_str!("main.rs");
        for command in [
            "create_project",
            "restart_hub",
            "register_project",
            "inspect_project",
            "run_existing_project",
        ] {
            let body = source
                .split(&format!("async fn {command}("))
                .nth(1)
                .unwrap()
                .split("#[tauri::command]")
                .next()
                .unwrap();
            assert!(body.contains("let operation = lifecycle::LIFECYCLE.command()?;"));
            assert!(body.contains("let _operation = operation;"));
        }
    }
}
