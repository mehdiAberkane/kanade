//! The build of the end-to-end tests (`--features e2e`, `npm run test:e2e`),
//! never published: the release and installer builds leave the feature out.
//! What WebDriver cannot reach comes from the environment the test starts
//! Kanade with:
//! - `KANADE_E2E_DATA`: the folder of the database and of the cache, in place
//!   of `%LOCALAPPDATA%\fr.devsecopsforce.kanade`, so that a run on a
//!   developer's PC never touches their library. Without it, no database:
//!   Kanade says so and writes nothing.
//! - `KANADE_E2E_LIBRARY`: the folder the folder picker answers with, since
//!   the picker is a window of Windows, out of WebDriver's reach. Without
//!   it, the picker answers as if closed.
//! - `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`: the options the Edge WebDriver
//!   gives WebView2, handed on as the window's own ([`with_webdriver_options`]).
//!
//! The update check is left out too (lib.rs): the test does not depend on
//! GitHub, and no update window comes over the page. And the build has an
//! identifier of its own (`tauri.e2e.conf.json`), so that WebView2 keeps its
//! data in `%LOCALAPPDATA%\fr.devsecopsforce.kanade.e2e`, apart from the
//! installed Kanade's.

use std::path::PathBuf;

use tauri::{Context, Runtime};

const DATA: &str = "KANADE_E2E_DATA";
const LIBRARY: &str = "KANADE_E2E_LIBRARY";
/// What the Edge WebDriver gives WebView2 to drive it, among which the
/// debugging port it connects to (`--remote-debugging-port=0`).
const WEBDRIVER_OPTIONS: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
/// What wry gives WebView2 when the app gives nothing (wry 0.57,
/// `webview2/mod.rs`): no mini menu over a selection, no SmartScreen, and
/// sound that plays without a click, as Tauri asks.
const WRY_OPTIONS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
                           --autoplay-policy=no-user-gesture-required";
const DISABLE_FEATURES: &str = "--disable-features=";

fn folder(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The folder of the database and of the cache.
pub fn data_dir() -> Result<PathBuf, String> {
    folder(DATA).ok_or_else(|| format!("{DATA} is not set (end-to-end test build)"))
}

/// The folder the folder picker answers with.
pub fn picked_folder() -> Option<PathBuf> {
    folder(LIBRARY)
}

/// The Edge WebDriver's options, given to WebView2 as the window's own.
///
/// The driver puts them in `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`. WebView2
/// reads that variable on a PC, but on GitHub's Windows runners it keeps
/// only the options the app gives (wry's): no debugging port opens, and the
/// driver gives up after 60 s (« DevToolsActivePort file doesn't exist »).
/// The folder the driver gives in `WEBVIEW2_USER_DATA_FOLDER` is kept there,
/// so WebView2 writes its port where the driver looks.
pub fn with_webdriver_options<R: Runtime>(context: Context<R>) -> Context<R> {
    let options = std::env::var(WEBDRIVER_OPTIONS).ok();
    with_options(context, options.as_deref())
}

fn with_options<R: Runtime>(mut context: Context<R>, webdriver: Option<&str>) -> Context<R> {
    let Some(webdriver) = webdriver.filter(|options| !options.trim().is_empty()) else {
        return context;
    };
    let options = browser_options(webdriver);
    for window in &mut context.config_mut().app.windows {
        window.additional_browser_args = Some(options.clone());
    }
    context
}

/// wry's options, then the driver's. WebView2 keeps only the last value of a
/// switch given twice: the features to disable are put together in one.
/// Options are split at spaces; the driver's have none inside.
fn browser_options(webdriver: &str) -> String {
    let mut features: Vec<&str> = Vec::new();
    let mut others = Vec::new();
    for option in WRY_OPTIONS
        .split_whitespace()
        .chain(webdriver.split_whitespace())
    {
        if let Some(list) = option.strip_prefix(DISABLE_FEATURES) {
            for feature in list.split(',').filter(|feature| !feature.is_empty()) {
                if !features.contains(&feature) {
                    features.push(feature);
                }
            }
        } else {
            others.push(option);
        }
    }
    let disable = format!("{DISABLE_FEATURES}{}", features.join(","));
    std::iter::once(disable.as_str())
        .chain(others)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use tauri::test::{mock_context, noop_assets};
    use tauri::utils::config::WindowConfig;

    use super::*;

    /// What msedgedriver 157 gives, shortened.
    const DRIVER: &str = "--allow-pre-commit-input --disable-features=IgnoreDuplicateNavs,Prewarm \
                          --enable-automation --remote-debugging-port=0 --test-type=webdriver";

    #[test]
    fn keeps_wry_options_then_adds_the_drivers() {
        assert_eq!(
            browser_options(DRIVER),
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,IgnoreDuplicateNavs,Prewarm \
             --autoplay-policy=no-user-gesture-required --allow-pre-commit-input \
             --enable-automation --remote-debugging-port=0 --test-type=webdriver"
        );
    }

    #[test]
    fn disables_each_feature_once_in_a_single_switch() {
        let options =
            browser_options("--disable-features=msPdfOOUI,,Prewarm --disable-features=Prewarm");
        assert_eq!(options.matches(DISABLE_FEATURES).count(), 1);
        assert!(options.starts_with(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,Prewarm "
        ));
    }

    fn context_with_a_window() -> Context<tauri::test::MockRuntime> {
        let mut context = mock_context(noop_assets());
        context.config_mut().app.windows = vec![WindowConfig::default()];
        context
    }

    #[test]
    fn gives_the_window_the_drivers_options() {
        let context = with_options(context_with_a_window(), Some(DRIVER));
        let options = context.config().app.windows[0]
            .additional_browser_args
            .as_deref();
        assert_eq!(options, Some(browser_options(DRIVER).as_str()));
    }

    #[test]
    fn leaves_wry_alone_without_a_driver() {
        for webdriver in [None, Some(""), Some("  ")] {
            let context = with_options(context_with_a_window(), webdriver);
            assert_eq!(
                context.config().app.windows[0].additional_browser_args,
                None
            );
        }
    }
}
