fn main() {
    // The Windows app manifest (Common Controls v6) goes in every binary the
    // linker writes, the test ones included: tauri-build would put it in the
    // app only, and a test that builds a Tauri app (commands.rs) imports
    // TaskDialogIndirect, which Windows does not find without it.
    let manifest = std::path::Path::new("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
            std::fs::canonicalize(manifest)
                .expect("windows-app-manifest.xml is missing")
                .display()
        );
    }
    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("tauri-build failed");
}
