import SwiftUI
import WebKit

struct WebViewContainer: UIViewRepresentable {
    let url: URL
    let onOpenSettings: () -> Void
    @Binding var isLoading: Bool
    @Binding var errorMessage: String?

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = WKWebsiteDataStore.default()
        config.preferences.javaScriptCanOpenWindowsAutomatically = true

        // Inject Native JavaScript Bridge
        let userScript = WKUserScript(
            source: NativeBridge.injectionScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        config.userContentController.addUserScript(userScript)

        let bridge = NativeBridge()
        bridge.delegate = context.coordinator
        context.coordinator.bridge = bridge
        config.userContentController.add(bridge, name: NativeBridge.handlerName)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.backgroundColor = UIColor(red: 0.055, green: 0.063, blue: 0.078, alpha: 1.0)
        webView.isOpaque = false
        webView.scrollView.backgroundColor = UIColor(red: 0.055, green: 0.063, blue: 0.078, alpha: 1.0)

        // Custom Safari User-Agent to allow Google & Discord OAuth logins
        webView.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"

        context.coordinator.webView = webView
        context.coordinator.currentServerUrl = url

        let request = URLRequest(url: url)
        webView.load(request)
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        // Only reload if the configured server URL actually changed in settings
        if context.coordinator.currentServerUrl != url {
            context.coordinator.currentServerUrl = url
            uiView.load(URLRequest(url: url))
        }
    }

    class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, NativeBridgeDelegate {
        var parent: WebViewContainer
        weak var webView: WKWebView?
        var bridge: NativeBridge?
        var currentServerUrl: URL?

        init(_ parent: WebViewContainer) {
            self.parent = parent
        }

        func didRequestServerSettings() {
            parent.onOpenSettings()
        }

        func didToggleKeepAwake(_ enable: Bool) {
            UIApplication.shared.isIdleTimerDisabled = enable
        }

        func didRequestShare(url: URL) {
            let activityVC = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
               let rootVC = windowScene.windows.first?.rootViewController {
                rootVC.present(activityVC, animated: true)
            }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            DispatchQueue.main.async {
                self.parent.isLoading = true
                self.parent.errorMessage = nil
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            DispatchQueue.main.async {
                self.parent.isLoading = false
            }
            if let currentUrl = webView.url {
                let path = currentUrl.path
                if path.hasPrefix("/drive") || path.hasPrefix("/convoy") {
                    UIApplication.shared.isIdleTimerDisabled = true
                }
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            let nsError = error as NSError
            // Ignore NSURLErrorCancelled (-999): fires on redirects, 302s, and superseded requests
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
                return
            }
            DispatchQueue.main.async {
                self.parent.isLoading = false
                self.parent.errorMessage = error.localizedDescription
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
                return
            }
            DispatchQueue.main.async {
                self.parent.isLoading = false
                self.parent.errorMessage = error.localizedDescription
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let reqUrl = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }

            let scheme = reqUrl.scheme?.lowercased() ?? ""
            if scheme == "mailto" || scheme == "tel" || scheme == "sms" {
                UIApplication.shared.open(reqUrl)
                decisionHandler(.cancel)
                return
            }

            // If OAuth provider redirects to localhost/127.0.0.1 callback, route it to the active server
            if (reqUrl.host == "localhost" || reqUrl.host == "127.0.0.1") && reqUrl.path.hasPrefix("/api/auth/") {
                if let serverHost = parent.url.host, serverHost != "localhost" && serverHost != "127.0.0.1" {
                    var components = URLComponents(url: reqUrl, resolvingAgainstBaseURL: false)
                    components?.scheme = parent.url.scheme
                    components?.host = parent.url.host
                    components?.port = parent.url.port
                    if let targetUrl = components?.url {
                        decisionHandler(.cancel)
                        webView?.load(URLRequest(url: targetUrl))
                        return
                    }
                }
            }

            decisionHandler(.allow)
        }

        // Support target="_blank" and popup windows for OAuth
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if navigationAction.targetFrame == nil {
                webView.load(navigationAction.request)
            }
            return nil
        }

        // JavaScript Alerts & Confirms
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let alert = UIAlertController(title: "PhotoScout", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default, handler: { _ in completionHandler() }))
            topViewController()?.present(alert, animated: true)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let alert = UIAlertController(title: "PhotoScout", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel, handler: { _ in completionHandler(false) }))
            alert.addAction(UIAlertAction(title: "OK", style: .default, handler: { _ in completionHandler(true) }))
            topViewController()?.present(alert, animated: true)
        }

        private func topViewController() -> UIViewController? {
            guard let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                  let rootVC = windowScene.windows.first?.rootViewController else {
                return nil
            }
            var top = rootVC
            while let presented = top.presentedViewController {
                top = presented
            }
            return top
        }
    }
}
