import SwiftUI
import WebKit

struct WebViewHost: NSViewRepresentable {
    @ObservedObject var supervisor: CoreSupervisor

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()

        // Inject window.__ECHO_SCRIBE__ before any scripts run
        let injectionScript = WKUserScript(
            source: makeInjectionScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(injectionScript)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        loadContent(webView)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // Re-inject and reload when port becomes available
        if supervisor.port != nil {
            let injectionScript = WKUserScript(
                source: makeInjectionScript(),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
            webView.configuration.userContentController.removeAllUserScripts()
            webView.configuration.userContentController.addUserScript(injectionScript)
            loadContent(webView)
        }
    }

    private func makeInjectionScript() -> String {
        let host = "127.0.0.1"
        let port = supervisor.port ?? 0
        return "window.__ECHO_SCRIBE__ = { host: '\(host)', port: \(port) };"
    }

    private func loadContent(_ webView: WKWebView) {
        #if DEBUG
        // Dev mode: load Vite dev server
        if let url = URL(string: "http://localhost:5173") {
            webView.load(URLRequest(url: url))
        }
        #else
        // Release mode: load bundled dist/index.html
        if let indexURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "ui") {
            webView.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())
        }
        #endif
    }
}
