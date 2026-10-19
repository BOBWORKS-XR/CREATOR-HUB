use super::*;

fn packet() -> Frame {
    Frame {
        kind: Kind::Prepare,
        target: Target {
            generation: "a".repeat(64),
            version: "0.1.17".into(),
        },
    }
}

#[test]
fn bounded_frame_rejects_commands_paths_unknown_versions_padding_and_sizes() {
    let frame = packet();
    let bytes = frame.encode().unwrap();
    assert_eq!(Frame::decode(&bytes).unwrap(), frame);
    for index in [0, 4, 5, 6, 8, 72, 136] {
        let mut bad = bytes;
        bad[index] = 255;
        assert!(Frame::decode(&bad).is_err());
    }
    for length in [0, 1, FRAME_SIZE - 1, FRAME_SIZE + 1, 4096] {
        assert!(Frame::decode(&vec![0; length]).is_err());
    }
    let mut bad = packet();
    bad.target.generation = "/tmp/anything".into();
    assert!(bad.encode().is_err());
    bad = packet();
    bad.target.version = "sh -c true".into();
    assert!(bad.encode().is_err());
}

#[test]
fn real_socket_packets_have_per_message_kernel_credentials_not_creation_authority() {
    let (sender, receiver) = Channel::pair().unwrap();
    receiver.validate().unwrap();
    sender.send(&packet()).unwrap();
    let Received::Packet(frame, credentials) = receiver.receive().unwrap() else {
        panic!("packet")
    };
    assert_eq!(frame, packet());
    assert_eq!(credentials.pid, unsafe { libc::getpid() });
    assert_eq!(credentials.uid, unsafe { libc::getuid() });
    assert_eq!(credentials.gid, unsafe { libc::getgid() });
    assert!(matches!(receiver.receive().unwrap(), Received::Pending));
    drop(sender);
    assert!(matches!(receiver.receive().unwrap(), Received::Closed));
}

#[test]
fn actual_child_message_credentials_differ_from_socketpair_creation_credentials() {
    let (receiver, inherited) = Channel::pair().unwrap();
    let mut creation: libc::ucred = unsafe { mem::zeroed() };
    let mut length = mem::size_of_val(&creation) as libc::socklen_t;
    assert_eq!(
        unsafe {
            libc::getsockopt(
                receiver.fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut creation as *mut libc::ucred).cast(),
                &mut length,
            )
        },
        0
    );
    assert_eq!(creation.pid, unsafe { libc::getpid() });
    let descriptor = inherited.fd();
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "store::restart::linux::tests::credential_sender_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("CREATOR_RESTART_TEST_CHILD", "1")
        .env(CHANNEL_MARKER, "1");
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(descriptor, CHILD_FD) < 0 || libc::fcntl(CHILD_FD, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().unwrap();
    drop(inherited);
    let (frame, credentials) = receiver.wait(Instant::now() + ADMISSION_TIMEOUT).unwrap();
    assert_eq!(frame, packet());
    assert_eq!(credentials.pid, child.id() as i32);
    assert_ne!(credentials.pid, creation.pid);
    assert_eq!(credentials.uid, unsafe { libc::getuid() });
    assert!(child.wait().unwrap().success());
}

#[test]
#[ignore = "Only the fixed transport parent test may start this unit-test child"]
fn credential_sender_fixture() {
    assert_eq!(
        std::env::var("CREATOR_RESTART_TEST_CHILD").as_deref(),
        Ok("1")
    );
    let channel = Channel::inherited().unwrap().unwrap();
    channel.send(&packet()).unwrap();
}

#[test]
fn stream_or_regular_descriptor_cannot_be_an_inherited_restart_channel() {
    let (stream, _) = std::os::unix::net::UnixStream::pair().unwrap();
    assert!(Channel(stream.into()).validate().is_err());
    let file = tempfile::tempfile().unwrap();
    assert!(Channel(file.into()).validate().is_err());
}

#[test]
fn oversize_and_empty_packets_are_refused_not_eof_or_truncated_success() {
    let (sender, receiver) = Channel::pair().unwrap();
    for size in [FRAME_SIZE + 1, 4096, 0] {
        let data = vec![0u8; size];
        assert_eq!(
            unsafe {
                libc::send(
                    sender.fd(),
                    data.as_ptr().cast(),
                    data.len(),
                    libc::MSG_NOSIGNAL,
                )
            },
            size as isize
        );
        assert!(receiver.receive().is_err());
    }
}

fn send_rights(sender: &Channel, descriptor: RawFd, count: usize) {
    let mut data = packet().encode().unwrap();
    let mut vector = libc::iovec {
        iov_base: data.as_mut_ptr().cast(),
        iov_len: data.len(),
    };
    let mut control = vec![0usize; 256];
    let size = count * mem::size_of::<RawFd>();
    let mut message: libc::msghdr = unsafe { mem::zeroed() };
    message.msg_iov = &mut vector;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = unsafe { libc::CMSG_SPACE(size as _) } as usize;
    unsafe {
        let header = libc::CMSG_FIRSTHDR(&message);
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(size as _) as usize;
        for index in 0..count {
            std::ptr::write_unaligned(
                libc::CMSG_DATA(header)
                    .add(index * mem::size_of::<RawFd>())
                    .cast::<RawFd>(),
                descriptor,
            );
        }
        assert_eq!(
            libc::sendmsg(sender.fd(), &message, libc::MSG_NOSIGNAL),
            FRAME_SIZE as isize
        );
    }
}

fn references(path: &Path) -> usize {
    fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(|v| v.ok())
        .filter(|v| fs::read_link(v.path()).ok().as_deref() == Some(path))
        .count()
}

#[test]
fn rights_extra_ancillary_and_control_truncation_are_rejected_and_fds_closed() {
    let file = tempfile::NamedTempFile::new().unwrap();
    let path = file.path().canonicalize().unwrap();
    assert_eq!(references(&path), 1);
    for count in [1, 200] {
        let (sender, receiver) = Channel::pair().unwrap();
        send_rights(&sender, file.as_raw_fd(), count);
        assert!(receiver.receive().is_err());
        assert_eq!(
            references(&path),
            1,
            "Received SCM_RIGHTS descriptors must not leak"
        );
        assert!(file.as_file().metadata().unwrap().is_file());
    }
}

#[test]
fn kernel_process_birth_parser_and_image_pid_start_checks_are_exact() {
    let pid = unsafe { libc::getpid() };
    let process = Process::capture(pid).unwrap();
    let credentials = Credentials {
        pid,
        uid: unsafe { libc::getuid() },
        gid: unsafe { libc::getgid() },
    };
    process.check(credentials).unwrap();
    assert!(process
        .check(Credentials {
            pid: pid + 1,
            ..credentials
        })
        .is_err());
    assert!(process
        .check(Credentials {
            uid: credentials.uid + 1,
            ..credentials
        })
        .is_err());
    let wrong_start = Process {
        birth: Birth {
            start: process.birth.start + 1,
            ..process.birth
        },
        image: process.image.try_clone().unwrap(),
    };
    assert!(wrong_start.live().is_err());
    let wrong_image = Process {
        birth: process.birth,
        image: tempfile::tempfile().unwrap(),
    };
    assert!(wrong_image.live().is_err());
    let mut fields = vec!["0"; 20];
    fields[0] = "S";
    fields[1] = "12";
    fields[19] = "456";
    let text = format!("123 (name (with) spaces) {}", fields.join(" "));
    assert_eq!(
        parse_stat(123, &text).unwrap(),
        Birth {
            pid: 123,
            parent: 12,
            start: 456
        }
    );
    assert!(parse_stat(124, &text).is_err());
    assert!(parse_stat(123, "123 (broken) S 1").is_err());
}

// These exercise the real credentialled packet transport and the production
// prepare/abort path. Private construction bypasses package admission ONLY in
// unit tests; this is not signed Root/AppRun or installed acceptance evidence.
fn protocol_client(channel: Channel) -> RootRestart {
    let pid = unsafe { libc::getpid() };
    RootRestart {
        channel,
        root: PathBuf::from("/unit-test-not-a-production-store"),
        before: SelectionSnapshot {
            bytes: Vec::new(),
            selection: Selection {
                schema_version: 1,
                generation: "b".repeat(64),
                version: "0.1.16".into(),
                previous_generation: None,
            },
        },
        me: Process::capture(pid).unwrap(),
        selector: Process::capture(pid).unwrap(),
        pending: None,
        ready: None,
        intent_sent: false,
        disposition: RestartDisposition::Idle,
        spent: true,
    }
}

#[test]
fn accepted_arm_with_delayed_armed_ack_is_aborted_before_future_exit_zero() {
    for acknowledge_abort in [true, false] {
        let (root_channel, peer_channel) = Channel::pair().unwrap();
        let mut client = protocol_client(root_channel);
        assert!(client.normal_exit_allowed());
        let old = target_of(&client.before);
        let target = packet().target;
        let target_for_peer = target.clone();
        let peer = std::thread::spawn(move || {
            let sender = Process::capture(unsafe { libc::getpid() }).unwrap();
            let mut machine = Machine::new();
            machine
                .accept(Kind::HelloAck, old.clone(), &old, Duration::ZERO)
                .unwrap();
            let deadline = Instant::now() + ADMISSION_TIMEOUT;
            let (proposal, cred) = peer_channel.wait(deadline).unwrap();
            sender.check(cred).unwrap();
            assert_eq!(proposal.kind, Kind::Prepare);
            assert_eq!(proposal.target, target_for_peer);
            assert_eq!(
                machine
                    .accept(
                        proposal.kind,
                        proposal.target.clone(),
                        &old,
                        Duration::from_secs(1)
                    )
                    .unwrap(),
                Some(Kind::Ready)
            );
            peer_channel
                .send(&Frame {
                    kind: Kind::Ready,
                    target: proposal.target,
                })
                .unwrap();
            let (arm, cred) = peer_channel.wait(deadline).unwrap();
            sender.check(cred).unwrap();
            assert_eq!(arm.kind, Kind::Arm);
            assert_eq!(
                machine
                    .accept(arm.kind, arm.target.clone(), &old, Duration::from_secs(2))
                    .unwrap(),
                Some(Kind::Armed)
            );
            // Deliberately withhold Armed until prepare has failed and sent its
            // authenticated abort. No scheduler sleep/generic injected failure.
            let (abort, cred) = peer_channel.wait(deadline).unwrap();
            sender.check(cred).unwrap();
            assert_eq!(abort.kind, Kind::Cancel);
            assert_eq!(
                machine
                    .accept(
                        abort.kind,
                        abort.target.clone(),
                        &old,
                        Duration::from_secs(3)
                    )
                    .unwrap(),
                Some(Kind::Cancelled)
            );
            if acknowledge_abort {
                peer_channel
                    .send(&Frame {
                        kind: Kind::Armed,
                        target: arm.target,
                    })
                    .unwrap();
                peer_channel
                    .send(&Frame {
                        kind: Kind::Cancelled,
                        target: abort.target,
                    })
                    .unwrap();
            }
            // Dropping the peer without an ACK is also observable, but only
            // because this exact modeled Root remains alive during resolution.
            assert!(machine.exited(Some(0), Duration::from_secs(4)).is_none());
        });
        // Only the post-Arm ACK deadline is already expired; Ready must really
        // arrive first, then the real peer must accept Arm before seeing abort.
        let result = client.prepare_after_validation(
            target.clone(),
            Instant::now() + ADMISSION_TIMEOUT,
            Instant::now(),
            &|client, credentials| client.selector.check(credentials),
        );
        assert!(result.is_err());
        peer.join().unwrap();
        assert!(client.ready.is_none());
        assert_eq!(result.unwrap_err().kind, ErrorKind::Refused);
        assert!(client.pending.is_none());
        assert!(client.normal_exit_allowed());
        if acknowledge_abort {
            assert_eq!(client.disposition(), RestartDisposition::Aborted);
        } else {
            assert_eq!(client.disposition(), RestartDisposition::PeerClosedSafe);
        }
    }
}

#[test]
fn unacknowledged_preparation_is_safe_not_armed_without_claiming_peer_abort() {
    let (root_channel, peer_channel) = Channel::pair().unwrap();
    let mut client = protocol_client(root_channel);
    client.pending = Some(packet().target);
    client.abort_with_deadline(Instant::now()).unwrap();
    assert_eq!(client.disposition(), RestartDisposition::SafeNotArmed);
    assert!(client.normal_exit_allowed());
    assert!(client.pending.is_none());
    // The peer really receives Cancel followed by terminal EOF, not a fabricated
    // Cancelled response. No ExitIntent has ever been sent.
    let (cancel, _) = peer_channel
        .wait(Instant::now() + ADMISSION_TIMEOUT)
        .unwrap();
    assert_eq!(cancel.kind, Kind::Cancel);
    assert!(matches!(peer_channel.receive().unwrap(), Received::Closed));
}

#[test]
fn unresolved_exit_authorization_retains_authority_until_observable_peer_eof() {
    let (root_channel, peer_channel) = Channel::pair().unwrap();
    let mut client = protocol_client(root_channel);
    client.pending = Some(packet().target);
    client.intent_sent = true;
    client.disposition = RestartDisposition::Unknown;
    assert_eq!(
        client.abort_with_deadline(Instant::now()).unwrap_err().kind,
        ErrorKind::OutcomeUnknown
    );
    assert_eq!(client.disposition(), RestartDisposition::Unknown);
    assert!(!client.normal_exit_allowed());
    assert!(client.pending.is_some());
    let (cancel, _) = peer_channel
        .wait(Instant::now() + ADMISSION_TIMEOUT)
        .unwrap();
    assert_eq!(cancel.kind, Kind::Cancel);
    drop(peer_channel);
    client.abort_pending().unwrap();
    assert_eq!(client.disposition(), RestartDisposition::PeerClosedSafe);
    assert!(client.normal_exit_allowed());
    assert!(client.pending.is_none());
}

#[test]
fn authorized_abort_drains_late_exit_ack_and_requires_matching_cancelled() {
    let (root_channel, peer_channel) = Channel::pair().unwrap();
    let mut client = protocol_client(root_channel);
    let target = packet().target;
    client.pending = Some(target.clone());
    client.intent_sent = true;
    client.disposition = RestartDisposition::Unknown;
    for kind in [Kind::ExitGranted, Kind::Cancelled] {
        peer_channel
            .send(&Frame {
                kind,
                target: target.clone(),
            })
            .unwrap();
    }
    client.abort_pending().unwrap();
    assert_eq!(client.disposition(), RestartDisposition::Aborted);
    assert!(client.normal_exit_allowed());
}

#[test]
fn unread_cancel_on_seqpacket_close_really_reports_kernel_reset_before_eof() {
    let (root_channel, peer_channel) = Channel::pair().unwrap();
    root_channel
        .send(&Frame {
            kind: Kind::Cancel,
            target: packet().target,
        })
        .unwrap();
    peer_channel.shutdown();
    drop(peer_channel);
    // Preserve the raw syscall observation, rather than turning arbitrary
    // receive errors into modeled closure. This is a real AF_UNIX packet pair.
    let mut bytes = [0u8; FRAME_SIZE];
    let count = unsafe {
        libc::recv(
            root_channel.fd(),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
            libc::MSG_DONTWAIT,
        )
    };
    assert_eq!(count, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ECONNRESET)
    );
    assert!(matches!(root_channel.receive().unwrap(), Received::Closed));
}

#[test]
fn abort_resolution_drains_reset_and_authenticated_late_ack_but_requires_actual_eof() {
    for late_ack in [false, true] {
        let (root_channel, peer_channel) = Channel::pair().unwrap();
        let client = protocol_client(root_channel);
        let target = packet().target;
        client
            .channel
            .send(&Frame {
                kind: Kind::Cancel,
                target: target.clone(),
            })
            .unwrap();
        if late_ack {
            peer_channel
                .send(&Frame {
                    kind: Kind::ExitGranted,
                    target: target.clone(),
                })
                .unwrap();
        }
        peer_channel.shutdown();
        drop(peer_channel);
        let authenticated = std::cell::Cell::new(0);
        let alive = std::cell::Cell::new(false);
        let result = resolve_abort(
            &client.channel,
            &target,
            Instant::now() + ADMISSION_TIMEOUT,
            &|cred| {
                client.selector.check(cred)?;
                authenticated.set(authenticated.get() + 1);
                Ok(())
            },
            &|| {
                client.me.alive_image()?;
                alive.set(true);
                Ok(())
            },
        );
        assert!(matches!(result.unwrap(), AbortResolution::PeerClosed));
        assert_eq!(authenticated.get(), i32::from(late_ack));
        assert!(alive.get());
    }
}

#[test]
fn reset_cleanup_does_not_hide_unexpected_packet_or_skip_live_root_proof() {
    for unexpected_packet in [false, true] {
        let (root_channel, peer_channel) = Channel::pair().unwrap();
        let mut client = protocol_client(root_channel);
        client.me.birth.start = client.me.birth.start.saturating_add(1);
        let target = packet().target;
        client
            .channel
            .send(&Frame {
                kind: Kind::Cancel,
                target: target.clone(),
            })
            .unwrap();
        if unexpected_packet {
            peer_channel
                .send(&Frame {
                    kind: Kind::Hello,
                    target: target.clone(),
                })
                .unwrap();
        }
        peer_channel.shutdown();
        drop(peer_channel);
        let authenticated = std::cell::Cell::new(false);
        let alive_checked = std::cell::Cell::new(false);
        let result = resolve_abort(
            &client.channel,
            &target,
            Instant::now() + ADMISSION_TIMEOUT,
            &|cred| {
                client.selector.check(cred)?;
                authenticated.set(true);
                Ok(())
            },
            &|| {
                alive_checked.set(true);
                client.me.alive_image()
            },
        );
        assert!(result.is_err());
        assert_eq!(authenticated.get(), unexpected_packet);
        assert_eq!(alive_checked.get(), !unexpected_packet);
    }
}

#[test]
fn real_exit_intent_exchange_distinguishes_acknowledged_and_delayed_authorization() {
    for delayed in [false, true] {
        let (root_channel, peer_channel) = Channel::pair().unwrap();
        let mut client = protocol_client(root_channel);
        let old = target_of(&client.before);
        let target = packet().target;
        let peer_target = target.clone();
        let peer = std::thread::spawn(move || {
            let sender = Process::capture(unsafe { libc::getpid() }).unwrap();
            let mut machine = Machine::new();
            machine
                .accept(Kind::HelloAck, old.clone(), &old, Duration::ZERO)
                .unwrap();
            for kind in [Kind::Prepare, Kind::Arm, Kind::ExitIntent] {
                let (frame, credentials) = peer_channel
                    .wait(Instant::now() + ADMISSION_TIMEOUT)
                    .unwrap();
                sender.check(credentials).unwrap();
                assert_eq!(
                    frame,
                    Frame {
                        kind,
                        target: peer_target.clone()
                    }
                );
                let reply = machine
                    .accept(kind, frame.target.clone(), &old, Duration::from_secs(1))
                    .unwrap()
                    .unwrap();
                if kind != Kind::ExitIntent || !delayed {
                    peer_channel
                        .send(&Frame {
                            kind: reply,
                            target: frame.target,
                        })
                        .unwrap();
                }
            }
            assert!(matches!(machine.phase, Phase::Exiting(_, _)));
            let (abort, credentials) = peer_channel
                .wait(Instant::now() + ADMISSION_TIMEOUT)
                .unwrap();
            sender.check(credentials).unwrap();
            assert_eq!(abort.kind, Kind::Cancel);
            assert_eq!(
                machine
                    .accept(
                        abort.kind,
                        abort.target.clone(),
                        &old,
                        Duration::from_secs(2)
                    )
                    .unwrap(),
                Some(Kind::Cancelled)
            );
            if delayed {
                peer_channel
                    .send(&Frame {
                        kind: Kind::ExitGranted,
                        target: peer_target.clone(),
                    })
                    .unwrap();
            }
            peer_channel
                .send(&Frame {
                    kind: Kind::Cancelled,
                    target: peer_target,
                })
                .unwrap();
            assert!(machine.exited(Some(0), Duration::from_secs(3)).is_none());
        });
        let deadline = Instant::now() + ADMISSION_TIMEOUT;
        let ready = client
            .prepare_after_validation(target.clone(), deadline, deadline, &|client, cred| {
                client.selector.check(cred)
            })
            .unwrap();
        client.require_token(&ready).unwrap();
        assert_eq!(client.disposition(), RestartDisposition::Prepared);
        assert!(client.normal_exit_allowed());
        client.ready = None;
        let result = client.authorize_after_validation(
            target,
            if delayed { Instant::now() } else { deadline },
            &|client, cred| client.selector.check(cred),
        );
        if delayed {
            assert_eq!(result.unwrap_err().kind, ErrorKind::Refused);
        } else {
            result.unwrap();
            assert_eq!(client.disposition(), RestartDisposition::ExitAuthorized);
            client.abort_pending().unwrap();
        }
        peer.join().unwrap();
        assert_eq!(client.disposition(), RestartDisposition::Aborted);
        assert!(client.normal_exit_allowed());
        assert!(client.pending.is_none());
    }
}

#[test]
fn disarm_is_observable_before_waiting_for_still_running_child() {
    use std::io::Write as _;
    use std::process::{Command, Stdio};
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "store::restart::linux::tests::wait_for_release_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("CREATOR_HUB_RESTART_WAIT_FIXTURE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut release = child.stdin.take().unwrap();
    let (root_channel, peer_channel) = Channel::pair().unwrap();
    let mut client = protocol_client(root_channel);
    let target = packet().target;
    let old = target_of(&client.before);
    client.pending = Some(target.clone());
    client.intent_sent = true;
    client.disposition = RestartDisposition::Unknown;
    let mut machine = Machine::new();
    machine
        .accept(Kind::HelloAck, old.clone(), &old, Duration::ZERO)
        .unwrap();
    for kind in [Kind::Prepare, Kind::Arm, Kind::ExitIntent] {
        machine
            .accept(kind, target.clone(), &old, Duration::from_secs(1))
            .unwrap();
    }
    assert!(machine.expired(Duration::from_secs(61)));
    let (done, completion) = std::sync::mpsc::channel();
    let peer = std::thread::spawn(move || {
        // CI 39335649930 failed here with unread Cancel at peer shutdown.
        // Observe it queued without consuming it, making that close/reset race
        // deterministic. The child was spawned before either socket existed.
        let deadline = Instant::now() + ADMISSION_TIMEOUT;
        loop {
            let mut queued: libc::c_int = 0;
            assert_eq!(
                unsafe { libc::ioctl(peer_channel.fd(), libc::FIONREAD, &mut queued) },
                0
            );
            if queued != 0 {
                assert_eq!(queued as usize, FRAME_SIZE);
                break;
            }
            assert!(Instant::now() < deadline, "Root never queued its Cancel");
            peer_channel.poll(deadline);
        }
        let result = wait_disarmed(child, peer_channel, &mut machine);
        assert!(matches!(machine.phase, Phase::Disarmed));
        assert!(machine.exited(Some(0), Duration::from_secs(62)).is_none());
        done.send(()).unwrap();
        result
    });
    client.abort_pending().unwrap();
    assert_eq!(client.disposition(), RestartDisposition::PeerClosedSafe);
    assert!(matches!(
        completion.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    release.write_all(&[1]).unwrap();
    assert!(
        matches!(peer.join().unwrap().unwrap(), ObservedExit::Unarmed(status, true) if status.success())
    );
}

#[test]
#[ignore = "spawned only by the bounded disarm test with a private release pipe"]
fn wait_for_release_fixture() {
    assert_eq!(
        std::env::var("CREATOR_HUB_RESTART_WAIT_FIXTURE").unwrap(),
        "1"
    );
    let mut release = [0];
    std::io::stdin().read_exact(&mut release).unwrap();
    assert_eq!(release, [1]);
}
