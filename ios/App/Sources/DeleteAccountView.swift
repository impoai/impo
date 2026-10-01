import SwiftUI
import InstantClient
import AuthenticationServices

struct DeleteAccountView: View {
    @Environment(AppModel.self) private var model
    @Environment(ListeningModel.self) private var listening
    @Environment(\.dismiss) private var dismiss
    @State private var challenge: AccountDeletionChallenge?
    @State private var confirmation = ""
    @State private var busy = false
    @State private var error: String?
    @State private var appleAuthorization = AppleDeletionAuthorization()
    @State private var appleUnavailable = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Image(systemName: "person.crop.circle.badge.minus").font(.system(size: 34)).foregroundStyle(InstantStyle.accent)
                    Text(challenge == nil ? "Delete your account?" : "One final confirmation")
                        .font(InstantStyle.serif(30)).accessibilityIdentifier("account-deletion.heading")
                    Text("This permanently deletes your conversations, tasks, Briefs, memories and Echo recordings, including audio waiting to upload on this iPhone. Your connected apps will be disconnected.")
                    Text("You will be signed out immediately. Cloud cleanup normally finishes within 24 hours. This cannot be undone. Data in your connected apps stays in those apps.")
                        .foregroundStyle(InstantStyle.muted)
                    if challenge != nil {
                        Text("Type DELETE to confirm.").font(.headline)
                        TextField("DELETE", text: $confirmation).textInputAutocapitalization(.characters).autocorrectionDisabled()
                            .textFieldStyle(.roundedBorder).accessibilityIdentifier("account-deletion.confirmation")
                    }
                    if let error { Text(error).foregroundStyle(.red).accessibilityIdentifier("account-deletion.error") }
                    Button(action: { proceed() }) {
                        HStack { Spacer(); if busy { ProgressView() }; Text(challenge == nil ? "Continue" : "Permanently delete account"); Spacer() }.padding(.vertical, 12)
                    }.buttonStyle(.borderedProminent).tint(challenge == nil ? InstantStyle.forest : .red)
                        .disabled(busy || (challenge != nil && confirmation != "DELETE"))
                        .accessibilityIdentifier(challenge == nil ? "account-deletion.continue" : "account-deletion.delete")
                    if appleUnavailable {
                        Button("Delete without Apple reauthorization", role: .destructive) { proceed(skipApple: true) }
                            .disabled(busy || confirmation != "DELETE")
                        Text("You can remove Impo from Sign in with Apple in your Apple Account settings afterward.").font(.footnote)
                    }
                    Button("Cancel") { dismiss() }.frame(maxWidth: .infinity).disabled(busy)
                }.padding(24)
            }.background(InstantStyle.paper).navigationTitle("Delete account").navigationBarTitleDisplayMode(.inline)
        }.interactiveDismissDisabled(busy)
    }
    private func proceed(skipApple: Bool = false) {
        busy = true; error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                if let challenge {
                    var code: String?
                    if challenge.appleAuthorizationAvailable == true && !skipApple {
                        do { code = try await appleAuthorization.authorize() }
                        catch {
                            appleUnavailable = true
                            self.error = "Apple authorization was not completed. Your Impo account has not been deleted. Try again, or continue without reauthorizing Apple."
                            return
                        }
                    }
                    try await model.deleteAccount(challenge: challenge, confirmation: confirmation, appleAuthorizationCode: code, listening: listening)
                }
                else {
                    guard let client = model.listeningClient() else { throw CancellationError() }
                    challenge = try await client.prepareAccountDeletion()
                }
            } catch let failure as InstantAPIError {
                error = failure.message
                if failure.statusCode == 409 { challenge = nil; confirmation = "" }
            } catch { self.error = "Couldn't confirm account deletion. Check your connection and try again." }
        }
    }
}

struct AccountDeletionReceiptView: View {
    @Environment(AppModel.self) private var model
    @Environment(ListeningModel.self) private var listening
    @Environment(\.dismiss) private var dismiss
    @State private var status = "deleting"
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(status == "deleted" ? "Your account is deleted." : "Your account is closed.").font(InstantStyle.serif(30))
                    Text(status == "deleted" ? "Your account and its cloud cleanup are complete." : "You have been signed out. Your account data is unavailable, and cloud cleanup is running. It normally finishes within 24 hours; you can check here for confirmation.")
                    if let message = model.deletionCleanupError { Text(message).foregroundStyle(.red) }
                    if model.savedDeletion?.receipt.appleManualRevocationRequired == true {
                        Text("Apple authorization could not be removed automatically. Remove Impo in Settings → your name → Sign in with Apple. This does not delay deletion of your Impo account.").foregroundStyle(InstantStyle.muted)
                    }
                    if let error { Text(error).foregroundStyle(.red) }
                    Button(busy ? "Checking…" : "Check deletion status") { Task { await refresh() } }.disabled(busy)
                    Link("Privacy and retention details", destination: URL(string: "https://impo.ai/privacy/#delete")!)
                }.padding(24)
            }.background(InstantStyle.paper).navigationTitle("Account deletion").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.task { await refresh() }
    }
    private func refresh() async {
        guard let saved = model.savedDeletion, let token = saved.receipt.receiptToken else { return }
        busy = true; defer { busy = false }
        await model.finishLocalDeletion(listening: listening)
        do {
            status = try await InstantClient(baseURL: saved.endpoint, bearerToken: token).accountDeletionStatus(saved.receipt.requestId).status
            error = nil
        } catch { self.error = "Couldn't check the status. Your deletion request is still saved; try again when you are online." }
    }
}

@MainActor private final class AppleDeletionAuthorization: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<String, Error>?
    private var controller: ASAuthorizationController?
    func authorize() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let request = ASAuthorizationAppleIDProvider().createRequest()
            let controller = ASAuthorizationController(authorizationRequests: [request])
            self.controller = controller; controller.delegate = self; controller.presentationContextProvider = self
            controller.performRequests()
        }
    }
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        defer { continuation = nil; self.controller = nil }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let data = credential.authorizationCode, let code = String(data: data, encoding: .utf8) else {
            continuation?.resume(throwing: CancellationError()); return
        }
        continuation?.resume(returning: code)
    }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        continuation?.resume(throwing: error); continuation = nil; self.controller = nil
    }
}
