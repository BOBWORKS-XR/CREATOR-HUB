//! Session activation only. This service cannot read settings, execute supplied
//! commands or authorize a GUI. Core admits its owned GUI on a separate channel.
use gio::glib::{variant::ToVariant, VariantTy};

const NAME: &str = "com.creatorworks.hub.Host";
const PATH: &str = "/com/creatorworks/hub/Host";
const INTERFACE: &str = "com.creatorworks.hub.Host1";
const XML: &str =
    "<node><interface name='com.creatorworks.hub.Host1'><method name='Start'/></interface></node>";

pub(super) struct Service {
    connection: gio::DBusConnection,
    registration: Option<gio::RegistrationId>,
}

impl Drop for Service {
    fn drop(&mut self) {
        if let Some(registration) = self.registration.take() {
            let _ = self.connection.unregister_object(registration);
        }
        let _ = self.connection.call_sync(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "ReleaseName",
            Some(&(NAME,).to_variant()),
            Some(VariantTy::new("(u)").unwrap()),
            gio::DBusCallFlags::NONE,
            1_000,
            gio::Cancellable::NONE,
        );
    }
}

pub(super) fn serve(start: impl Fn() -> bool + Send + Sync + 'static) -> Result<Service, String> {
    let connection = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)
        .map_err(|_| "Cannot connect the Hub helper to this desktop session.")?;
    let info = gio::DBusNodeInfo::for_xml(XML).map_err(|_| "Invalid Hub activation interface.")?;
    let interface = info
        .lookup_interface(INTERFACE)
        .ok_or("Missing Hub activation interface.")?;
    let registration = connection
        .register_object(
            PATH,
            &interface,
            move |_connection, _sender, path, interface, method, parameters, invocation| {
                if path != PATH
                    || interface != INTERFACE
                    || method != "Start"
                    || parameters.get::<()>().is_none()
                {
                    invocation.return_dbus_error(
                        "com.creatorworks.hub.Host.InvalidRequest",
                        "Only Start() is supported.",
                    );
                } else if start() {
                    invocation.return_value(Some(&().to_variant()));
                } else {
                    invocation.return_dbus_error(
                        "com.creatorworks.hub.Host.Busy",
                        "Hub is finishing an operation. Try again shortly.",
                    );
                }
            },
            |_connection, _sender, _path, _interface, _property| ().to_variant(),
            |_connection, _sender, _path, _interface, _property, _value| false,
        )
        .map_err(|_| "Cannot register the fixed Hub activation method.")?;
    let acquired = connection.call_sync(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "RequestName",
        Some(&(NAME, 4u32).to_variant()),
        Some(VariantTy::new("(u)").unwrap()),
        gio::DBusCallFlags::NONE,
        5_000,
        gio::Cancellable::NONE,
    );
    match acquired.ok().and_then(|value| value.get::<(u32,)>()) {
        Some((1,)) => Ok(Service {
            connection,
            registration: Some(registration),
        }),
        _ => {
            let _ = connection.unregister_object(registration);
            Err("Another Hub helper already owns desktop activation. No GUI was started.".into())
        }
    }
}

pub(super) fn start() -> Result<(), String> {
    let connection = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)
        .map_err(|_| "Cannot connect to your desktop session.")?;
    connection.call_sync(
        Some(NAME), PATH, INTERFACE, "Start", Some(&().to_variant()), Some(VariantTy::UNIT),
        gio::DBusCallFlags::NONE, 15_000, gio::Cancellable::NONE,
    ).map_err(|_| "Hub host support is unavailable. Install the matching native Hub host helper, then open Hub again. No settings were changed.")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_has_one_method_and_no_arguments_or_properties() {
        let node = gio::DBusNodeInfo::for_xml(XML).unwrap();
        let interface = node.lookup_interface(INTERFACE).unwrap();
        assert!(interface.lookup_method("Start").is_some());
        assert!(interface.lookup_method("Execute").is_none());
        assert_eq!(XML.matches("<method ").count(), 1);
        assert!(!XML.contains("<arg"));
        assert!(!XML.contains("<property"));
        assert!(!XML.contains("<signal"));
        assert_eq!(().to_variant().type_(), VariantTy::UNIT);
        assert!(().to_variant().get::<()>().is_some());
        assert!(("path",).to_variant().get::<()>().is_none());
    }

    #[test]
    #[ignore = "Disposable private session bus in the explicit Linux Core CI fixture only"]
    fn native_activation_round_trip_has_no_host_operation_arguments() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc,
        };
        use std::time::Duration;
        assert_eq!(
            std::env::var("CREATOR_FLATPAK_BOOTSTRAP_TEST").as_deref(),
            Ok("1")
        );
        assert_eq!(std::env::var("GITHUB_ACTIONS").as_deref(), Ok("true"));
        assert_eq!(
            std::env::var("GITHUB_REF").as_deref(),
            Ok("refs/heads/validation/linux-flatpak-core-014")
        );
        let calls = Arc::new(AtomicUsize::new(0));
        let (ready, receiver) = mpsc::sync_channel(1);
        let count = calls.clone();
        let server = std::thread::spawn(move || {
            let context = gio::glib::MainContext::new();
            context
                .with_thread_default(|| {
                    let main_loop = gio::glib::MainLoop::new(Some(&context), false);
                    let _service = serve(move || {
                        count.fetch_add(1, Ordering::SeqCst);
                        true
                    })
                    .unwrap();
                    ready.send((context.clone(), main_loop.clone())).unwrap();
                    main_loop.run();
                })
                .unwrap();
        });
        let (context, main_loop) = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        start().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let connection = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE).unwrap();
        assert!(connection
            .call_sync(
                Some(NAME),
                PATH,
                INTERFACE,
                "Start",
                Some(&("unexpected",).to_variant()),
                None,
                gio::DBusCallFlags::NONE,
                2_000,
                gio::Cancellable::NONE
            )
            .is_err());
        assert!(connection
            .call_sync(
                Some(NAME),
                PATH,
                INTERFACE,
                "Execute",
                Some(&().to_variant()),
                None,
                gio::DBusCallFlags::NONE,
                2_000,
                gio::Cancellable::NONE
            )
            .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        context.invoke(move || main_loop.quit());
        server.join().unwrap();
    }
}
