import SwiftUI

struct ServerSetupView: View {
    @Binding var currentServerUrl: String
    @Binding var isPresented: Bool
    
    @State private var inputUrl: String = ""
    @State private var isTesting = false
    @State private var testResult: String?
    @State private var isSuccess = false

    var body: some View {
        ZStack {
            Color(red: 0.055, green: 0.063, blue: 0.078) // #0e1014
                .ignoresSafeArea()

            VStack(spacing: 24) {
                Spacer()

                VStack(spacing: 12) {
                    Image(systemName: "location.north.circle.fill")
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 72, height: 72)
                        .foregroundColor(Color(red: 0.96, green: 0.65, blue: 0.14)) // #f5a623

                    Text("Connect to PhotoScout")
                        .font(.title2.bold())
                        .foregroundColor(.white)

                    Text("Enter your PhotoScout instance URL to connect.")
                        .font(.subheadline)
                        .foregroundColor(Color(white: 0.7))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }

                VStack(spacing: 16) {
                    TextField("https://photoscout.example.com", text: $inputUrl)
                        .padding()
                        .background(Color(red: 0.094, green: 0.11, blue: 0.14)) // #181c24
                        .cornerRadius(12)
                        .foregroundColor(.white)
                        .textInputAutocapitalization(.never)
                        .disableAutocorrection(true)
                        .keyboardType(.URL)

                    if let result = testResult {
                        Text(result)
                            .font(.footnote)
                            .foregroundColor(isSuccess ? Color(red: 0.06, green: 0.73, blue: 0.51) : Color(red: 0.94, green: 0.27, blue: 0.27))
                            .multilineTextAlignment(.center)
                    }

                    Button(action: testConnection) {
                        HStack {
                            if isTesting {
                                ProgressView()
                                    .progressViewStyle(CircularProgressViewStyle(tint: Color(red: 0.96, green: 0.65, blue: 0.14)))
                            } else {
                                Text("Test Connection")
                                    .fontWeight(.semibold)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .overlay(
                            RoundedRectangle(cornerRadius: 12)
                                .stroke(Color(red: 0.96, green: 0.65, blue: 0.14), lineWidth: 1.5)
                        )
                        .foregroundColor(Color(red: 0.96, green: 0.65, blue: 0.14))
                    }
                    .disabled(isTesting || inputUrl.trimmingCharacters(in: .whitespaces).isEmpty)

                    Button(action: saveAndConnect) {
                        Text("Connect")
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity)
                            .frame(height: 48)
                            .background(Color(red: 0.96, green: 0.65, blue: 0.14))
                            .foregroundColor(Color(red: 0.055, green: 0.063, blue: 0.078))
                            .cornerRadius(12)
                    }
                    .disabled(inputUrl.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .padding(.horizontal, 24)

                Text("Supports any self-hosted PhotoScout server.\nHTTPS is recommended.")
                    .font(.caption)
                    .foregroundColor(Color(white: 0.5))
                    .multilineTextAlignment(.center)

                Spacer()
            }
        }
        .onAppear {
            if !currentServerUrl.isEmpty {
                inputUrl = currentServerUrl
            }
        }
    }

    private func cleanUrl(_ raw: String) -> String {
        var url = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !url.hasPrefix("http://") && !url.hasPrefix("https://") {
            url = "https://\(url)"
        }
        while url.hasSuffix("/") {
            url.removeLast()
        }
        return url
    }

    private func testConnection() {
        let cleaned = cleanUrl(inputUrl)
        guard let url = URL(string: "\(cleaned)/api/version") else {
            testResult = "Invalid URL"
            isSuccess = false
            return
        }

        isTesting = true
        testResult = nil

        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.setValue("PhotoScoutiOS/1.0", forHTTPHeaderField: "User-Agent")

        URLSession.shared.dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
                self.isTesting = false
                if let error = error {
                    self.testResult = "Connection failed: \(error.localizedDescription)"
                    self.isSuccess = false
                    return
                }

                if let http = response as? HTTPURLResponse, http.statusCode == 200, let data = data {
                    if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        let version = json["display"] as? String ?? json["version"] as? String ?? "ready"
                        self.testResult = "PhotoScout server reached (v\(version))"
                        self.isSuccess = true
                        return
                    }
                }
                self.testResult = "Unexpected server response"
                self.isSuccess = false
            }
        }.resume()
    }

    private func saveAndConnect() {
        let cleaned = cleanUrl(inputUrl)
        UserDefaults.standard.set(cleaned, forKey: "server_url")
        currentServerUrl = cleaned
        isPresented = false
    }
}
