//! Shared compatibility identity for the desktop WebView's actual HTTP User-Agent.
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
struct ClientIdentity {
    name: String,
    version: String,
}

fn identity() -> &'static ClientIdentity {
    static IDENTITY: OnceLock<ClientIdentity> = OnceLock::new();
    IDENTITY.get_or_init(|| serde_json::from_str(include_str!("../../src/utils/defaultClientIdentity.json"))
        .expect("Bundled default client identity must be valid"))
}

fn format_user_agent(platform: Option<&str>) -> String {
    let identity = identity();
    let base = format!("{}/{}", identity.name, identity.version);
    platform.map_or_else(|| base.clone(), |platform| format!("{base} ({platform})"))
}

#[cfg(windows)]
fn windows_platform() -> String {
    // RtlGetVersion reports the real Windows build without manifest/version-helper emulation.
    #[repr(C)]
    struct VersionInfo {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut VersionInfo) -> i32;
    }
    let mut version = VersionInfo {
        size: std::mem::size_of::<VersionInfo>() as u32,
        major: 0, minor: 0, build: 0, platform: 0, service_pack: [0; 128],
    };
    let arch = if cfg!(target_arch = "x86_64") { "x64" } else { std::env::consts::ARCH };
    // SAFETY: the system function receives an initialized, correctly sized writable structure.
    if unsafe { RtlGetVersion(&mut version) } >= 0 {
        format!("Windows NT {}.{}.{}; {arch}", version.major, version.minor, version.build)
    } else {
        format!("Windows; {arch}")
    }
}

pub fn http_user_agent() -> String {
    #[cfg(windows)]
    { format_user_agent(Some(&windows_platform())) }
    #[cfg(not(windows))]
    { format_user_agent(None) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_identity_formats_short_and_platform_agents() {
        assert_eq!(format_user_agent(None), "RodelPlayer/2.2610.12.0");
        assert_eq!(format_user_agent(Some("Windows NT 10.0.12345; x64")),
            "RodelPlayer/2.2610.12.0 (Windows NT 10.0.12345; x64)");
    }

    #[test]
    fn desktop_agent_uses_the_current_platform() {
        let agent = http_user_agent();
        assert!(agent.starts_with("RodelPlayer/2.2610.12.0"));
        assert!(!agent.contains(['\r', '\n']));
        #[cfg(windows)]
        assert!(agent.contains("(Windows NT ") && agent.ends_with(')'));
    }
}
