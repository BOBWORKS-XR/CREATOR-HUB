//! A native operation belongs to the backend session, not a renderer promise.
//! Pipe loss retains it until the actual backend exits and accepted work drains.
use serde_json::Value;

#[derive(Clone, Copy)]
enum Action {
    Command,
    Begin,
    Finish(u32),
}

pub struct SessionOperation<G> {
    guard: Option<G>,
    workflow: Option<u32>,
    active: Option<Action>,
    draining: bool,
}

impl<G> Default for SessionOperation<G> {
    fn default() -> Self {
        Self {
            guard: None,
            workflow: None,
            active: None,
            draining: false,
        }
    }
}

impl<G> SessionOperation<G> {
    pub fn begin(
        &mut self,
        command: &str,
        args: &Value,
        reserve: impl FnOnce() -> Result<G, String>,
    ) -> Result<(), String> {
        if self.draining || self.active.is_some() {
            return Err("Hosted operation is active or draining. Nothing was sent.".into());
        }
        let fields = args.as_object().ok_or("Invalid hosted arguments.")?;
        let action = match command {
            "begin_ui_operation" => {
                if self.workflow.is_some() || !fields.is_empty() {
                    return Err("A workflow is already active or its arguments are invalid.".into());
                }
                Action::Begin
            }
            "finish_ui_operation" => {
                let id = fields
                    .get("id")
                    .and_then(Value::as_u64)
                    .and_then(|id| u32::try_from(id).ok())
                    .filter(|id| *id != 0)
                    .ok_or("Invalid workflow receipt.")?;
                if fields.len() != 1 || self.workflow != Some(id) {
                    return Err("Workflow receipt does not belong to this hosted session.".into());
                }
                Action::Finish(id)
            }
            _ => Action::Command,
        };
        if self.guard.is_none() {
            self.guard = Some(reserve()?);
        }
        self.active = Some(action);
        Ok(())
    }

    pub fn complete(&mut self, result: &Result<Value, String>) -> Result<(), String> {
        let action = self.active.take().ok_or("No hosted command is active.")?;
        if self.draining {
            return Err("The hosted outcome is unknown until its backend exits.".into());
        }
        match (action, result) {
            (Action::Begin, Ok(value)) => {
                let Some(id) = value
                    .as_u64()
                    .and_then(|id| u32::try_from(id).ok())
                    .filter(|id| *id != 0)
                else {
                    self.draining = true;
                    return Err(
                        "Backend returned an invalid workflow receipt; waiting for shutdown."
                            .into(),
                    );
                };
                self.workflow = Some(id);
            }
            (Action::Finish(id), Ok(value)) => {
                if !value.is_null() || self.workflow != Some(id) {
                    self.draining = true;
                    return Err(
                        "Backend did not acknowledge workflow completion; waiting for shutdown."
                            .into(),
                    );
                }
                self.workflow = None;
            }
            _ => {}
        }
        if self.workflow.is_none() {
            self.guard.take();
        }
        Ok(())
    }

    pub fn disconnect(&mut self) {
        self.draining = true;
    }

    pub fn backend_exited(&mut self) {
        self.draining = true;
        self.active = None;
        self.workflow = None;
        self.guard.take();
    }

    pub fn busy(&self) -> bool {
        self.guard.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    struct Guard(Arc<AtomicUsize>);
    impl Drop for Guard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    fn reserve(count: &Arc<AtomicUsize>) -> Result<Guard, String> {
        assert_eq!(count.fetch_add(1, Ordering::SeqCst), 0);
        Ok(Guard(Arc::clone(count)))
    }

    #[test]
    fn guard_covers_workflow_gaps_and_only_matching_finish_releases_it() {
        let count = Arc::new(AtomicUsize::new(0));
        let mut op = SessionOperation::default();
        op.begin("begin_ui_operation", &json!({}), || reserve(&count))
            .unwrap();
        assert!(op.busy());
        op.complete(&Ok(json!(7))).unwrap();
        assert!(op.busy());
        assert!(op
            .begin("finish_ui_operation", &json!({"id":8}), || reserve(&count))
            .is_err());
        op.begin("save_config", &json!({}), || {
            panic!("Do not reacquire between commands")
        })
        .unwrap();
        op.complete(&Err("validation failed".into())).unwrap();
        assert!(op.busy());
        op.begin("finish_ui_operation", &json!({"id":7}), || panic!())
            .unwrap();
        op.complete(&Ok(Value::Null)).unwrap();
        assert!(!op.busy());
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn pipe_loss_keeps_guard_until_process_exit_even_between_requests() {
        for between in [false, true] {
            let count = Arc::new(AtomicUsize::new(0));
            let mut op = SessionOperation::default();
            op.begin("begin_ui_operation", &json!({}), || reserve(&count))
                .unwrap();
            if between {
                op.complete(&Ok(json!(2))).unwrap();
            }
            op.disconnect();
            assert_eq!(count.load(Ordering::SeqCst), 1);
            assert!(op
                .begin("finish_ui_operation", &json!({"id":2}), || panic!())
                .is_err());
            op.backend_exited();
            op.backend_exited();
            assert_eq!(count.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn ordinary_calls_release_after_ack_but_malformed_begin_fails_closed() {
        let count = Arc::new(AtomicUsize::new(0));
        let mut op = SessionOperation::default();
        op.begin("get_hosted_snapshot", &json!({}), || reserve(&count))
            .unwrap();
        op.complete(&Ok(json!({}))).unwrap();
        assert!(!op.busy());
        op.begin("begin_ui_operation", &json!({}), || reserve(&count))
            .unwrap();
        assert!(op.complete(&Ok(json!("not-a-receipt"))).is_err());
        assert!(op.busy());
        op.backend_exited();
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn foreign_session_or_invalid_receipt_never_reserves_or_finishes_work() {
        let mut op: SessionOperation<Guard> = SessionOperation::default();
        for args in [
            json!({}),
            json!({"id":0}),
            json!({"id":3}),
            json!({"id":-1}),
            json!({"id":4294967296_u64}),
            json!({"id":3,"extra":true}),
        ] {
            assert!(op.begin("finish_ui_operation", &args, || panic!()).is_err());
        }
        assert!(!op.busy());
        assert!(op
            .begin("begin_ui_operation", &json!({"id":1}), || panic!())
            .is_err());
        assert!(op
            .begin("read", &json!({}), || Err("other app is busy".into()))
            .is_err());
        assert!(!op.busy());
    }
}
