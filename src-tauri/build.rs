fn main() {
    // Windows: the application manifest (Common Controls v6, see windows-app-manifest.xml) goes in through the
    // linker instead of tauri-build's resource, so the Rust test binaries get it too: without it `cargo test`
    // exits at once with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139). The app's manifest is the same as before:
    // tauri-build's default contains exactly this dependency.
    let mut attrs = tauri_build::Attributes::new();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed=windows-app-manifest.xml");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        attrs = attrs.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    tauri_build::try_build(attrs).expect("tauri-build failed");
}
