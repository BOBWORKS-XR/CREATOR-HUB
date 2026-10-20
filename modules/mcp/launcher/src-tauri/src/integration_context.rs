//! Private dynamic scope: only an admitted in-process service call enters it.
use std::{cell::Cell, marker::PhantomData, rc::Rc};

thread_local! {
    static INTEGRATED: Cell<bool> = const { Cell::new(false) };
}

pub(crate) fn active() -> bool {
    INTEGRATED.with(Cell::get)
}

pub(crate) fn protected_writers() -> bool {
    active() || option_env!("CREATOR_HUB_INTERNAL_MODULE") == Some("1")
}

// Dropping on another thread would clear the wrong thread-local authority.
pub(crate) struct Scope(PhantomData<Rc<()>>);

impl Scope {
    pub(crate) fn enter() -> Result<Self, String> {
        if !cfg!(feature = "integrated-service") {
            return Err("This MCP build has no integrated service authority.".into());
        }
        INTEGRATED.with(|active| {
            if active.replace(true) {
                return Err("Nested integrated MCP calls are not permitted.".into());
            }
            Ok(Self(PhantomData))
        })
    }
}

impl Drop for Scope {
    fn drop(&mut self) {
        INTEGRATED.with(|active| active.set(false));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_cannot_move_or_be_shared_across_threads() {
        // Type inference becomes ambiguous if Scope ever implements either trait.
        trait AmbiguousIfSend<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousIfSend<()> for T {}
        impl<T: ?Sized + Send> AmbiguousIfSend<u8> for T {}
        let _ = <Scope as AmbiguousIfSend<_>>::check;

        trait AmbiguousIfSync<A> {
            fn check() {}
        }
        impl<T: ?Sized> AmbiguousIfSync<()> for T {}
        impl<T: ?Sized + Sync> AmbiguousIfSync<u8> for T {}
        let _ = <Scope as AmbiguousIfSync<_>>::check;
    }

    #[cfg(feature = "integrated-service")]
    #[test]
    fn explicit_scope_is_thread_local_rejects_nesting_and_restores_after_unwind() {
        assert!(!active());
        let result = std::panic::catch_unwind(|| {
            let _scope = Scope::enter().unwrap();
            assert!(active() && protected_writers());
            assert!(Scope::enter().is_err());
            assert!(active());
            assert!(!std::thread::spawn(active).join().unwrap());
            panic!("disposable scope unwind");
        });
        assert!(result.is_err());
        assert!(!active());
    }

    #[cfg(not(feature = "integrated-service"))]
    #[test]
    fn feature_off_cannot_enter_integrated_authority() {
        assert!(Scope::enter().is_err());
        assert!(!active());
    }
}
