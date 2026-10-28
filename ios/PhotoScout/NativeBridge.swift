import Foundation
import WebKit
import UIKit

protocol NativeBridgeDelegate: AnyObject {
    func didRequestServerSettings()
    func didToggleKeepAwake(_ enable: BooleanLiteralType)
    func didRequestShare(url: URL)
}

class NativeBridge: NSObject, WKScriptMessageHandler {
    static let handlerName = "PhotoScoutNative"
    weak var delegate: NativeBridgeDelegate?

    static var injectionScript: String {
        return """
        (function() {
            window.PhotoScoutNative = {
                isNative: true,
                platform: 'ios',
                version: '1.0.0',
                startBackgroundLocation: function() {
                    window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(handlerName).postMessage({ action: 'startBackgroundLocation' });
                },
                stopBackgroundLocation: function() {
                    window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(handlerName).postMessage({ action: 'stopBackgroundLocation' });
                },
                setKeepAwake: function(enable) {
                    window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(handlerName).postMessage({ action: 'setKeepAwake', enable: !!enable });
                },
                openServerSettings: function() {
                    window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(handlerName).postMessage({ action: 'openServerSettings' });
                },
                vibrate: function(ms) {
                    window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(handlerName).postMessage({ action: 'vibrate', ms: ms || 50 });
                }
            };
        })();
        """
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == NativeBridge.handlerName,
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
            return
        }

        switch action {
        case "startBackgroundLocation":
            LocationManager.shared.startBackgroundLocation()
        case "stopBackgroundLocation":
            LocationManager.shared.stopBackgroundLocation()
        case "setKeepAwake":
            let enable = body["enable"] as? Bool ?? false
            delegate?.didToggleKeepAwake(enable)
        case "openServerSettings":
            delegate?.didRequestServerSettings()
        case "vibrate":
            let generator = UIImpactFeedbackGenerator(style: .medium)
            generator.impactOccurred()
        default:
            break
        }
    }
}
