import SwiftUI

@main
struct PhotoScoutApp: App {
    @StateObject private var locationManager = LocationManager.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
                .onAppear {
                    locationManager.requestPermissions()
                }
        }
    }
}
