import SwiftUI

struct PasswordSignInView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var flow: PasswordSignInFlow
    @State private var email = ""
    @State private var password = ""
    @State private var code = ""

    init(onComplete: @escaping @MainActor () async throws -> Void) {
        _flow = State(initialValue: PasswordSignInFlow(onComplete: onComplete))
    }

    private var title: String {
        switch flow.step {
        case .credentials: "Sign in with email"
        case .resetEmail: "Reset your password"
        case .code: "Verify your account"
        case .newPassword: "Choose a new password"
        case .complete: "You're signed in"
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text(title).font(InstantStyle.serif(30)).foregroundStyle(InstantStyle.forest)
                    switch flow.step {
                    case .credentials, .resetEmail:
                        Text(flow.step == .credentials
                             ? "Use the email and password for your Impo account. New here? Go back to continue with Apple or Google."
                             : "We'll send a code to the email on your account.")
                            .foregroundStyle(InstantStyle.muted)
                        TextField("Email address", text: $email)
                            .textContentType(.username).keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("auth.email")
                            .passwordFormField()
                        if flow.step == .credentials {
                            SecureField("Password", text: $password).textContentType(.password)
                                .accessibilityIdentifier("auth.password").passwordFormField()
                        }
                        action(flow.step == .credentials ? "Sign in" : "Send reset code", enabled: !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (flow.step == .resetEmail || !password.isEmpty)) {
                            let secret = password; password = ""
                            if flow.step == .credentials { await flow.signIn(email: email, password: secret) }
                            else { await flow.sendReset(email: email) }
                        }
                        if flow.step == .credentials {
                            Button("Forgot password?") { password = ""; flow.showReset() }
                                .frame(minHeight: 44).accessibilityIdentifier("auth.forgot")
                        }
                    case .code:
                        Text(flow.codeHelp).foregroundStyle(InstantStyle.muted)
                        TextField("Verification code", text: $code).textContentType(.oneTimeCode)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("auth.code").passwordFormField()
                        action("Verify", enabled: !code.isEmpty && flow.codeSent) {
                            let entered = code; code = ""; await flow.verify(code: entered)
                        }
                        if flow.canResend {
                            Button(flow.codeSent ? "Resend code" : "Send code") { Task { await flow.resend() } }
                                .frame(minHeight: 44).accessibilityIdentifier("auth.resend")
                        }
                        if flow.factors.count > 1 {
                            Menu("Use another method") {
                                ForEach(Array(flow.factors.enumerated()), id: \.offset) { _, factor in
                                    Button(factor.passwordFlowLabel) { code = ""; Task { await flow.selectFactor(factor) } }
                                }
                            }.frame(minHeight: 44)
                        }
                    case .newPassword:
                        Text("Choose a password you haven't used elsewhere. Your other sessions will be signed out.")
                            .foregroundStyle(InstantStyle.muted)
                        SecureField("New password", text: $password).textContentType(.newPassword)
                            .accessibilityIdentifier("auth.newPassword").passwordFormField()
                        action("Save password and sign in", enabled: !password.isEmpty) {
                            let secret = password; password = ""; await flow.reset(password: secret)
                        }
                    case .complete: ProgressView()
                    }
                    if let error = flow.error {
                        Text(error).foregroundStyle(.red).font(.callout)
                            .accessibilityIdentifier("auth.error")
                    }
                    if flow.step != .credentials && flow.step != .complete {
                        Button("Back to sign in") { password = ""; code = ""; flow.startOver() }.frame(minHeight: 44)
                    }
                }
                .padding(24)
                .disabled(flow.busy)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(InstantStyle.paper)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { password = ""; code = ""; dismiss() }.disabled(flow.busy)
                }
            }
            .tint(InstantStyle.forest)
        }
        .interactiveDismissDisabled(flow.busy)
        .onChange(of: flow.step) { _, step in if step == .complete { dismiss() } }
    }

    private func action(_ title: String, enabled: Bool, operation: @escaping @MainActor () async -> Void) -> some View {
        Button { Task { await operation() } } label: {
            HStack { if flow.busy { ProgressView().tint(.white) }; Text(title) }
                .frame(maxWidth: .infinity, minHeight: 52)
                .foregroundStyle(.white).background(InstantStyle.forest, in: RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain).disabled(!enabled || flow.busy)
        .opacity(enabled ? 1 : 0.5).accessibilityIdentifier("auth.submit")
    }
}

private extension View {
    func passwordFormField() -> some View {
        padding(16).frame(minHeight: 54).paperSurface(cornerRadius: 14)
    }
}
