use creator_hub_flatpak_native_activation as contract;
use gio::glib::{variant::ToVariant, VariantTy};
use gtk::prelude::*;

fn activate() -> Result<(), &'static str> {
    let bus = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)
        .map_err(|_| "Cannot connect to the desktop session bus.")?;
    bus.call_sync(Some(contract::NAME), contract::PATH, contract::INTERFACE, contract::METHOD,
        Some(&().to_variant()), Some(VariantTy::UNIT), gio::DBusCallFlags::NONE, 15_000, gio::Cancellable::NONE)
        .map_err(|_| "Native Hub support is unavailable or did not confirm activation. Install the matching DEB-based native Hub, then try again. This launcher did not install software or change host settings.")?;
    Ok(())
}

fn installer_page() -> Result<(), &'static str> {
    let bus = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)
        .map_err(|_| "Cannot connect to the desktop portal.")?;
    let options = std::collections::HashMap::<String, gio::glib::Variant>::new();
    bus.call_sync(
        Some("org.freedesktop.portal.Desktop"),
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.OpenURI",
        "OpenURI",
        Some(&("", contract::installer_page(), options).to_variant()),
        Some(VariantTy::new("(o)").unwrap()),
        gio::DBusCallFlags::NONE,
        15_000,
        gio::Cancellable::NONE,
    )
    .map_err(|_| {
        "The desktop portal could not open the installer page. No native software was installed."
    })?;
    Ok(())
}

fn close_dialog(dialog: &gtk::MessageDialog) {
    dialog.close();
    while gtk::events_pending() {
        gtk::main_iteration_do(false);
    }
}

pub fn run() -> Result<(), &'static str> {
    contract::launcher_context(
        std::env::var("FLATPAK_ID").ok().as_deref(),
        std::env::args_os().count(),
    )?;
    gtk::init()
        .map_err(|_| "A working graphical desktop is required for Creator Hub activation.")?;
    let dialog = gtk::MessageDialog::new(
        None::<&gtk::Window>,
        gtk::DialogFlags::MODAL,
        gtk::MessageType::Info,
        gtk::ButtonsType::None,
        "Open native Creator Hub?",
    );
    dialog.set_title("Creator Hub");
    dialog.set_position(gtk::WindowPosition::Center);
    dialog.set_secondary_text(Some(contract::DISCLOSURE));
    dialog.add_buttons(&[
        ("Cancel", gtk::ResponseType::Cancel),
        ("Get Native Hub", gtk::ResponseType::Other(1)),
        ("Open Creator Hub", gtk::ResponseType::Accept),
    ]);
    dialog.set_default_response(gtk::ResponseType::Accept);
    let choice = dialog.run();
    close_dialog(&dialog);
    if choice == gtk::ResponseType::Other(1) {
        return installer_page();
    }
    if choice != gtk::ResponseType::Accept {
        return Ok(());
    }
    if let Err(message) = activate() {
        let error = gtk::MessageDialog::new(
            None::<&gtk::Window>,
            gtk::DialogFlags::MODAL,
            gtk::MessageType::Warning,
            gtk::ButtonsType::None,
            "Native Hub support is required",
        );
        error.set_title("Creator Hub");
        error.set_position(gtk::WindowPosition::Center);
        error.set_secondary_text(Some(message));
        error.add_buttons(&[
            ("Close", gtk::ResponseType::Close),
            ("Get Native Hub", gtk::ResponseType::Other(1)),
        ]);
        let choice = error.run();
        close_dialog(&error);
        if choice == gtk::ResponseType::Other(1) {
            installer_page()?;
        }
        return Err(message);
    }
    Ok(())
}
