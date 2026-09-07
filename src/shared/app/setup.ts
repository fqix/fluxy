export function setupInstructions(port: number, certificatePath: string): Record<string, string> {
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
    const ca = quote(certificatePath)
    const device = `Connect the device and Mac to the same network.\nIn Fluxy Settings, disable localhost-only listening, then start capture.\nConfigure the device Wi-Fi HTTP proxy with your Mac's LAN IP and port ${port}.\nExport the public root certificate from Certificate → Export.`
    return {
        'iOS Simulator': `Start the simulator, then run:\nxcrun simctl keychain booted add-root-cert ${ca}\n\nEnable Fluxy as the macOS System Proxy. Restart the test app and verify HTTPS capture.`,
        'iPhone or iPad': `${device}\nTransfer the public certificate to the device and install its profile in Settings.\nEnable full trust under Settings → General → About → Certificate Trust Settings.\nCertificate-pinned apps need a development configuration that trusts your test CA.`,
        'Android Emulator': `Configure the emulator HTTP proxy:\nadb shell settings put global http_proxy 10.0.2.2:${port}\n\nCopy the public root certificate:\nadb push ${ca} /sdcard/Download/Fluxy-CA.crt\nInstall it in Settings → Security → Encryption & credentials → Install a certificate → CA certificate.\nFor Android 7+ apps, configure a debug-only network_security_config to trust user certificates.\nTo remove the proxy later: adb shell settings put global http_proxy :0`,
        'Android Device': `${device}\nInstall the exported CA using Settings → Security → Encryption & credentials.\nFor Android 7+ apps, add a debug-only network_security_config with a user CA trust anchor.\nRemove the Wi-Fi proxy when finished.`,
        Java: `Import the CA into a dedicated development trust store (keytool prompts for its password):\nkeytool -importcert -alias fluxy -file ${ca} -keystore fluxy-dev-truststore.p12 -storetype PKCS12\n\nLaunch your test JVM with:\n-Djavax.net.ssl.trustStore=fluxy-dev-truststore.p12\n-Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=${port}\n-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=${port}\nSupply the trust-store password using your development launcher.`,
        Flutter: `Use your platform's development CA setup (iOS or Android) and configure its proxy.\nFor a dart:io development client, load the exported CA into a SecurityContext and set HttpClient.findProxy to PROXY <Mac-IP>:${port}.\nKeep this configuration in development builds only. Do not accept arbitrary invalid certificates.`,
        'React Native': `Configure the iOS/Android device proxy and trust the exported CA.\nFor Android debug builds, allow user CA certificates with a debug-only network_security_config.\nRestart the app after changing trust settings.`,
        Electron: `For an Electron development session:\nawait session.defaultSession.setProxy({ proxyRules: 'http=127.0.0.1:${port};https=127.0.0.1:${port}' });\n\nTrust the root CA in the operating system.\nNode.js requests additionally need NODE_EXTRA_CA_CERTS=${ca} before launch and an HTTP proxy agent.`,
        'Next.js': `Start the development server with the extra CA available:\nNODE_EXTRA_CA_CERTS=${ca} npm run dev\n\nConfigure your server-side HTTP client to use http://127.0.0.1:${port}.\nBrowser-side requests use the browser/OS proxy configuration.`,
        Firefox: `Firefox Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import.\nSelect the exported Fluxy root CA and allow it to identify websites.\nUnder Network Settings choose Manual proxy, host 127.0.0.1, port ${port}, and use it for HTTPS.\nRestart your test tabs. Remove the proxy when finished.`
    }
}

export function terminalEnvironment(port: number, certificatePath: string) {
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
    const proxy = `http://127.0.0.1:${port}`
    return Object.entries({
        http_proxy: proxy,
        https_proxy: proxy,
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        NO_PROXY: 'localhost,127.0.0.1,::1',
        no_proxy: 'localhost,127.0.0.1,::1',
        CURL_CA_BUNDLE: certificatePath,
        REQUESTS_CA_BUNDLE: certificatePath,
        SSL_CERT_FILE: certificatePath,
        NODE_EXTRA_CA_CERTS: certificatePath,
        GRPC_DEFAULT_SSL_ROOTS_FILE_PATH: certificatePath
    })
        .map(([name, value]) => `export ${name}=${quote(value)}`)
        .join('\n')
}
