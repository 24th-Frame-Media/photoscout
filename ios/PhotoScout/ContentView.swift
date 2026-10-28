import SwiftUI

struct ContentView: View {
    @State private var serverUrl: String = UserDefaults.standard.string(forKey: "server_url") ?? ""
    @State private var isShowingSettings: Bool = false
    @State private var isLoading: Bool = false
    @State private var errorMessage: String? = nil

    var body: some View {
        ZStack {
            Color(red: 0.055, green: 0.063, blue: 0.078) // #0e1014
                .ignoresSafeArea()

            if let url = URL(string: serverUrl), !serverUrl.isEmpty {
                VStack(spacing: 0) {
                    if isLoading {
                        ProgressView()
                            .progressViewStyle(LinearProgressViewStyle(tint: Color(red: 0.96, green: 0.65, blue: 0.14)))
                            .frame(height: 2)
                    }

                    WebViewContainer(
                        url: url,
                        onOpenSettings: { isShowingSettings = true },
                        isLoading: $isLoading,
                        errorMessage: $errorMessage
                    )
                }

                if let error = errorMessage {
                    VStack(spacing: 16) {
                        Text("Connection Failed")
                            .font(.headline)
                            .foregroundColor(.white)

                        Text(error)
                            .font(.subheadline)
                            .foregroundColor(Color(white: 0.7))
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)

                        Button(action: {
                            errorMessage = nil
                            isLoading = true
                        }) {
                            Text("Retry")
                                .fontWeight(.semibold)
                                .padding(.horizontal, 24)
                                .padding(.vertical, 10)
                                .background(Color(red: 0.96, green: 0.65, blue: 0.14))
                                .foregroundColor(Color(red: 0.055, green: 0.063, blue: 0.078))
                                .cornerRadius(8)
                        }

                        Button(action: { isShowingSettings = true }) {
                            Text("Change Server")
                                .font(.footnote)
                                .foregroundColor(Color(red: 0.96, green: 0.65, blue: 0.14))
                        }
                    }
                    .padding(32)
                    .background(Color(red: 0.094, green: 0.11, blue: 0.14))
                    .cornerRadius(16)
                    .shadow(radius: 10)
                    .padding(24)
                }
            } else {
                ServerSetupView(currentServerUrl: $serverUrl, isPresented: .constant(true))
            }
        }
        .sheet(isPresented: $isShowingSettings) {
            ServerSetupView(currentServerUrl: $serverUrl, isPresented: $isShowingSettings)
        }
    }
}
