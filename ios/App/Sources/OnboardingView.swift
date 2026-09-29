import SwiftUI
import PhotosUI

struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showingConsent = false
    @State private var selectedService: OnboardingService?
    @State private var nameDraft = ""
    @State private var introduction = ""
    @State private var photoSelection: PhotosPickerItem?
    @State private var photoData: Data?
    @State private var styleOffset = 0
    @State private var authError: String?
    @State private var isAuthenticating = false
    @State private var emailDraft = ""
    @State private var passwordDraft = ""
    @FocusState private var nameFocused: Bool
    @FocusState private var emailFieldFocused: Bool

    private let introText = "Hey, there you are.\n\nWe should probably introduce ourselves."

    var body: some View {
        ZStack {
            InstantBackground().ignoresSafeArea()
            Group {
                switch model.onboardingStep {
                case 0: welcome
                case 1: login
                case 2: connections
                case 3: intro
                case 4: name
                case 5: avatar
                default: trial
                }
            }
            .foregroundStyle(InstantStyle.ink)
            .accessibilityHidden(showingConsent || selectedService != nil)
            // Steps 2–5 have a Back button to the previous step; the edge swipe does the same.
            .swipeBack(enabled: (2...5).contains(model.onboardingStep) && !showingConsent && selectedService == nil) {
                advance(to: model.onboardingStep - 1)
            }

            if showingConsent { consentOverlay }
            if let service = selectedService { permissionOverlay(service) }
        }
        .preferredColorScheme(.light)
        .onChange(of: photoSelection) { _, selection in
            Task {
                guard let data = try? await selection?.loadTransferable(type: Data.self),
                      UIImage(data: data) != nil else { return }
                photoData = data
                UserDefaults.standard.set(data, forKey: "instant.avatarPhoto")
                model.avatarIndex = 6
                model.persistProfile()
            }
        }
    }

    private func advance(to step: Int) {
        nameFocused = false
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.22)) {
            model.onboardingStep = step
        }
    }

    /// Keep the reference layout when it fits; allow the same content to scroll
    /// on shorter phones and while the native keyboard reduces the viewport.
    private func fittingPage<Content: View>(@ViewBuilder content: @escaping () -> Content) -> some View {
        GeometryReader { viewport in
            ScrollView {
                content()
                    .frame(maxWidth: .infinity, minHeight: viewport.size.height, alignment: .top)
            }
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private var welcome: some View {
        fittingPage {
            VStack(alignment: .leading, spacing: 0) {
                Spacer(minLength: 60)
                HStack(alignment: .bottom) {
                    DotMark(vertical: true, size: 24)
                        .padding(.bottom, 15)
                    Spacer()
                    Image("JournalRobin")
                        .resizable().scaledToFit()
                        .frame(width: 138, height: 138)
                        .rotationEffect(.degrees(-5))
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
                .background(InstantStyle.accent.opacity(0.24), in: RoundedRectangle(cornerRadius: 20))
                .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(InstantStyle.accent.opacity(0.35), lineWidth: 1))
                .accessibilityHidden(true)
                .allowsHitTesting(false)
                .padding(.bottom, 34)
                VStack(alignment: .leading, spacing: 22) {
                    Text("Meet Impo,")
                    Text("an assistant that actually\nknows you,")
                    Text("and acts before you ask.")
                }
                .font(InstantStyle.serif(28))
                .lineSpacing(3)
                .foregroundStyle(InstantStyle.forest)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14)
                .padding(.bottom, 48)
                PillButton(title: "Let's begin") { advance(to: 1) }
                    .accessibilityIdentifier("onboarding.begin")
            }
            .padding(.horizontal, 22)
            .padding(.bottom, 20)
        }
    }

    private var login: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                Spacer(minLength: 24)
                DotMark(vertical: true, size: 17)
                    .padding(22)
                    .background(InstantStyle.accent.opacity(0.2), in: RoundedRectangle(cornerRadius: 24))
                    .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(InstantStyle.border, lineWidth: 1))
                    .padding(.bottom, 36)
                Text("Let's begin")
                    .font(InstantStyle.serif(30))
                    .foregroundStyle(InstantStyle.forest)
                Spacer(minLength: 42)
                VStack(spacing: 14) {
                    loginButton("Continue with Google", brand: .google, identifier: "onboarding.login")
                    loginButton("Continue with Microsoft", brand: .microsoft, identifier: "onboarding.login.microsoft")
                    loginButton("Continue with Apple", brand: .apple, identifier: "onboarding.login.apple")
                }
                if let authError {
                    Text(authError)
                        .font(.system(size: 13))
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .padding(.top, 8)
                        .accessibilityIdentifier("onboarding.login.error")
                }
                HStack(spacing: 9) {
                    Rectangle().fill(InstantStyle.border).frame(width: 72, height: 0.5)
                    Text("OR").font(.system(size: 13)).foregroundStyle(InstantStyle.muted)
                    Rectangle().fill(InstantStyle.border).frame(width: 72, height: 0.5)
                }
                .padding(.vertical, 17)
                emailPasswordForm
                Text("By proceeding to use Impo, you agree to our **terms of use** and acknowledge that you have read our **privacy policy**.")
                    .font(.system(size: 10))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(InstantStyle.muted)
                    .padding(.top, 28)
            }
            .padding(.horizontal, 22)
            .padding(.bottom, 16)
            .frame(height: geometry.size.height)
        }
    }

    private func loginButton(_ title: String, brand: LoginBrand, identifier: String) -> some View {
        Button {
            authError = nil
            isAuthenticating = true
            Task {
                do {
                    try await model.signIn(with: brand)
                    isAuthenticating = false
                    showingConsent = true
                } catch is CancellationError {
                    isAuthenticating = false
                } catch {
                    isAuthenticating = false
                    authError = "Couldn't sign in. Check your connection and try again."
                }
            }
        } label: {
            HStack(spacing: 11) {
                BrandMark(brand: brand).frame(width: 21, height: 23)
                Text(title).font(.system(size: 17))
            }
            .frame(maxWidth: .infinity).frame(height: 52)
            .paperSurface(cornerRadius: 16)
        }
        .buttonStyle(.plain)
        .disabled(isAuthenticating)
        .accessibilityIdentifier(identifier)
    }

    private var emailPasswordForm: some View {
        VStack(spacing: 10) {
            TextField("Personal or work email", text: $emailDraft)
                .textContentType(.username)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($emailFieldFocused)
                .font(.system(size: 17))
                .padding(.horizontal, 18).frame(height: 54)
                .paperSurface(cornerRadius: 16)
                .accessibilityIdentifier("onboarding.login.email.field")
            SecureField("Password", text: $passwordDraft)
                .textContentType(.password)
                .font(.system(size: 17))
                .padding(.horizontal, 18).frame(height: 54)
                .paperSurface(cornerRadius: 16)
                .accessibilityIdentifier("onboarding.login.password.field")
            Button {
                authError = nil
                isAuthenticating = true
                emailFieldFocused = false
                Task {
                    do {
                        try await model.signIn(email: emailDraft, password: passwordDraft)
                        isAuthenticating = false
                        showingConsent = true
                    } catch is CancellationError {
                        isAuthenticating = false
                    } catch {
                        isAuthenticating = false
                        authError = "Couldn't sign in. Check your email and password and try again."
                    }
                }
            } label: {
                Text("Continue")
                    .font(.system(size: 17))
                    .frame(maxWidth: .infinity).frame(height: 52)
                    .paperSurface(cornerRadius: 16)
            }
            .buttonStyle(.plain)
            .disabled(isAuthenticating || emailDraft.isEmpty || passwordDraft.isEmpty)
            .accessibilityIdentifier("onboarding.login.email.submit")
        }
    }

    private var consentOverlay: some View {
        ZStack {
            InstantStyle.forest.opacity(0.34).ignoresSafeArea()
            VStack(spacing: 12) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("AI Data Processing Notice")
                            .font(InstantStyle.serif(23))
                            .foregroundStyle(InstantStyle.forest)
                        noticeSection("What Data We Send", text: "Your messages are sent to the Impo server and then to our AI service to generate a response.")
                        noticeSection("How Your Data Is Used", text: "Your messages and conversation history are processed by the Impo server and our AI service so you can continue the same conversation. Include only information you want to share.")
                        noticeSection("Your Connections", text: "Calendar and Health use Apple’s permission screens. Gmail and other apps connect through their own sign-in screens. When you ask about connected data, selected results go to Impo and its AI service. Every connection is optional.")
                        noticeSection("Your Choice", text: "Continue only with information you want to include in the conversation. You can cancel to return to the welcome screen.")
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
                }
                .scrollIndicators(.visible)
                Text("By tapping I Agree, you acknowledge how Impo processes your messages.")
                    .font(.system(size: 11))
                    .foregroundStyle(InstantStyle.muted)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 8)
                HStack(spacing: 11) {
                    Button { showingConsent = false } label: {
                        Text("Cancel").font(.system(size: 17, weight: .semibold))
                            .frame(maxWidth: .infinity).frame(height: 48)
                            .instantGlass(cornerRadius: 18)
                    }
                    Button {
                        showingConsent = false
                        advance(to: 2)
                    } label: {
                        Text("I Agree").font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(InstantStyle.paperElevated)
                            .frame(maxWidth: .infinity).frame(height: 48)
                            .background(InstantStyle.forest, in: RoundedRectangle(cornerRadius: 18))
                    }
                    .accessibilityIdentifier("onboarding.agree")
                }
                .buttonStyle(.plain)
            }
            .padding(15)
            .padding(.top, 7)
            .frame(maxHeight: 610)
            .paperSurface(cornerRadius: 24)
            .padding(.horizontal, 29)
            .padding(.vertical, 28)
        }
        .foregroundStyle(InstantStyle.ink)
    }

    private func noticeSection(_ title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(InstantStyle.serif(18, weight: .bold))
            Text(text).font(.system(size: 14)).foregroundStyle(InstantStyle.muted).lineSpacing(4)
        }
    }

    private var connections: some View {
        VStack(spacing: 0) {
            progressHeader(fraction: 0.125, back: 1)
            DotMark(size: 15).padding(.top, 19).padding(.bottom, 30)
            Text("I need to know you to help you.")
                .font(InstantStyle.serif(23))
                .foregroundStyle(InstantStyle.forest)
                .minimumScaleFactor(0.8)
                .lineLimit(1)
                .padding(.horizontal, 20)
                .padding(.bottom, 22)
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(OnboardingService.allCases) { service in connectionCard(service) }
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 15)
            }
            .scrollIndicators(.hidden)
            .contentShape(Rectangle())
            .zIndex(0)
            VStack(spacing: 10) {
                PillButton(title: "Continue") { advance(to: 3) }
                    .contentShape(Capsule())
                    .accessibilityIdentifier("onboarding.connections.continue")
                HStack(spacing: 8) {
                    Text("Choose what to share · all optional")
                        .font(.system(size: 10))
                    Button("Skip for now") { advance(to: 3) }
                        .font(.system(size: 11, weight: .medium))
                        .underline()
                        .accessibilityIdentifier("onboarding.connections.skip")
                }
                .foregroundStyle(InstantStyle.muted)
            }
            .padding(.horizontal, 22)
            .padding(.top, 7)
            .padding(.bottom, 12)
            .zIndex(1)
        }
    }

    private func connectionCard(_ service: OnboardingService) -> some View {
        let connected = service == .calendar ? model.calendarEnabled : service == .health ? model.healthEnabled : model.connectedServices.contains(service.rawValue)
        return HStack(alignment: .top, spacing: 15) {
            ServiceMark(service: service).frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 6) {
                Text(service.title).font(InstantStyle.serif(19))
                Text(service.detail).font(.system(size: 13)).foregroundStyle(InstantStyle.muted).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                Button {
                    if service == .calendar || service == .health {
                        selectedService = service
                    } else if connected {
                        model.connectedServices.remove(service.rawValue)
                        model.persistProfile()
                    } else {
                        selectedService = service
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: connected ? "checkmark" : "plus").font(.system(size: 15, weight: .medium))
                        Text(connected ? "Connected" : "Connect").font(.system(size: 14))
                    }
                    .foregroundStyle(connected ? InstantStyle.forest : InstantStyle.ink)
                    .padding(.horizontal, 12).frame(height: 32)
                    .instantGlass(cornerRadius: 12, tint: InstantStyle.sage.opacity(0.12))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("onboarding.connect.\(service.rawValue)")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .paperSurface(cornerRadius: 16)
    }

    @ViewBuilder private func permissionOverlay(_ service: OnboardingService) -> some View {
        if service == .calendar || service == .health {
            ZStack {
                InstantStyle.forest.opacity(0.28).ignoresSafeArea()
                VStack(spacing: 18) {
                    Text("Share only what helps you.").font(InstantStyle.serif(25))
                    Text("When you ask in live chat, relevant data is shared with Impo and its AI service to answer your question.")
                        .font(.system(size: 14)).foregroundStyle(InstantStyle.muted)
                    DeviceAccessCard(kind: service.rawValue)
                    Button("Done") { selectedService = nil }
                        .font(.system(size: 17, weight: .medium)).frame(maxWidth: .infinity).padding(.vertical, 14)
                        .instantGlass(cornerRadius: 18).accessibilityIdentifier("onboarding.permission.done")
                }.padding(24).paperSurface(cornerRadius: 24).padding(24)
            }
        } else {
        ZStack {
            InstantStyle.forest.opacity(0.28).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .top) {
                    ServiceMark(service: service).frame(width: 56, height: 56)
                    Spacer()
                    Text("DEMO PREVIEW").font(.system(size: 10, weight: .semibold)).tracking(0.7)
                        .foregroundStyle(InstantStyle.muted).padding(.top, 4)
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Try \(service.title) with Impo")
                        .font(InstantStyle.serif(23))
                    Text("Explore how your assistant could help with \(service.permissionNoun). This preview uses sample data only.")
                        .font(.system(size: 15)).lineSpacing(3).foregroundStyle(InstantStyle.muted)
                }
                if service == .calendar {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("TUESDAY, SEP 22 · SAMPLE").font(.system(size: 10, weight: .semibold)).foregroundStyle(InstantStyle.accent)
                        HStack(spacing: 8) {
                            RoundedRectangle(cornerRadius: 2).fill(InstantStyle.sage).frame(width: 3)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Team catch-up").font(.system(size: 13, weight: .medium))
                                Text("10:30–11:15 AM").font(.system(size: 12)).foregroundStyle(InstantStyle.muted)
                            }
                        }
                    }
                    .padding(13)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: 77)
                    .paperSurface(cornerRadius: 14)
                }
                Text("No device permission is requested. Your real \(service.permissionNoun) stays private.")
                    .font(.system(size: 13)).lineSpacing(2)
                VStack(spacing: 8) {
                    Button {
                        model.connectedServices.insert(service.rawValue)
                        model.persistProfile()
                        selectedService = nil
                    } label: {
                        Text("Connect demo").font(.system(size: 17, weight: .medium))
                            .frame(maxWidth: .infinity).frame(height: 45)
                            .instantGlass(cornerRadius: 16)
                    }
                    .accessibilityIdentifier("onboarding.permission.allow")
                    Button { selectedService = nil } label: {
                        Text("Not now").font(.system(size: 17, weight: .medium))
                            .frame(maxWidth: .infinity).frame(height: 45)
                            .instantGlass(cornerRadius: 16)
                    }
                }
                .buttonStyle(.plain)
            }
            .padding(25)
            .paperSurface(cornerRadius: 24)
            .padding(.horizontal, 53)
        }
        .foregroundStyle(InstantStyle.ink)
        }
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 0) {
            progressHeader(fraction: 0.25, back: 2)
            DotMark(size: 15).padding(.top, 73).padding(.bottom, 32).padding(.leading, 27)
            Text(introduction)
                .font(InstantStyle.serif(24)).lineSpacing(4)
                .foregroundStyle(InstantStyle.forest)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 27)
                .onTapGesture { advance(to: 4) }
            Image("JournalRobin")
                .resizable().scaledToFit()
                .frame(width: 128, height: 128)
                .rotationEffect(.degrees(-7))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.trailing, 32)
                .padding(.top, 30)
                .accessibilityHidden(true)
                .allowsHitTesting(false)
            Spacer()
            Button {
                advance(to: 4)
            } label: {
                Text("Tap to continue").font(.system(size: 13)).foregroundStyle(InstantStyle.muted)
                    .frame(maxWidth: .infinity).frame(height: 48)
            }
            .accessibilityIdentifier("onboarding.intro.continue")
            .padding(.bottom, 15)
        }
        .task {
            introduction = ""
            for character in introText {
                guard !Task.isCancelled else { return }
                introduction.append(character)
                if !reduceMotion { try? await Task.sleep(for: .milliseconds(25)) }
            }
        }
    }

    private var name: some View {
        fittingPage {
            VStack(alignment: .leading, spacing: 0) {
                progressHeader(fraction: 0.375, back: 3)
                DotMark(size: 15)
                    .padding(.top, nameFocused ? 16 : 73)
                    .padding(.bottom, nameFocused ? 20 : 30)
                    .padding(.leading, 27)
                VStack(alignment: .leading, spacing: nameFocused ? 14 : 20) {
                    Text(model.displayName.isEmpty ? "Nice to meet you." : "Nice to meet you, \(model.displayName).")
                    Text("I'd like a name too.")
                    Text("What would you call me?")
                }
                .font(InstantStyle.serif(24))
                .foregroundStyle(InstantStyle.forest)
                .padding(.horizontal, 27)
                TextField("Name your assistant...", text: $nameDraft)
                    .font(InstantStyle.serif(24))
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .submitLabel(.continue)
                    .focused($nameFocused)
                    .onSubmit { saveName() }
                    .padding(.horizontal, 18)
                    .padding(.vertical, nameFocused ? 14 : 18)
                    .instantGlass(cornerRadius: 18)
                    .padding(.horizontal, 22)
                    .padding(.top, nameFocused ? 20 : 31)
                    .accessibilityIdentifier("onboarding.name.field")
                Spacer(minLength: nameFocused ? 10 : 18)
                Button {
                    let options = ["Momo", "Luna", "Nova", "Milo", "Sora", "Cleo"]
                    nameDraft = options.filter { $0 != nameDraft }.randomElement() ?? "Momo"
                } label: {
                    Label("Surprise me", systemImage: "dice.fill").font(.system(size: 15))
                        .foregroundStyle(InstantStyle.muted).frame(maxWidth: .infinity).frame(height: 40)
                }
                .accessibilityIdentifier("onboarding.name.surprise")
                PillButton(title: "Continue") { saveName() }
                    .accessibilityIdentifier("onboarding.name.continue")
                    .padding(.horizontal, 22)
                    .padding(.bottom, nameFocused ? 24 : 20)
            }
        }
        .task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            nameFocused = true
        }
    }

    private func saveName() {
        let trimmed = nameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        model.assistantName = trimmed.isEmpty ? "Momo" : String(trimmed.prefix(40))
        model.persistProfile()
        advance(to: 5)
    }

    private var avatar: some View {
        VStack(spacing: 0) {
            progressHeader(fraction: 0.5, back: 4)
            DotMark(size: 15).padding(.top, 18).padding(.bottom, 32)
            Text("Pick a look for \(model.assistantName)!")
                .font(InstantStyle.serif(24)).lineLimit(1).minimumScaleFactor(0.7)
                .padding(.horizontal, 20)
            GeometryReader { geometry in
                let points: [CGPoint] = [
                    CGPoint(x: 0.54, y: 0.17), CGPoint(x: 0.22, y: 0.36),
                    CGPoint(x: 0.79, y: 0.44), CGPoint(x: 0.5, y: 0.57),
                    CGPoint(x: 0.24, y: 0.80), CGPoint(x: 0.67, y: 0.87)
                ]
                let diameter = min(geometry.size.width * 0.23, 88)
                ForEach(0..<6) { position in
                    let look = AssistantLook.choices[(position + styleOffset) % AssistantLook.choices.count]
                    let index = look.rawValue
                    Button {
                        model.avatarIndex = index
                        model.persistProfile()
                    } label: {
                        AssistantAvatar(index: index, size: diameter)
                            .opacity(model.avatarIndex == index ? 1 : 0.64)
                            .overlay {
                                RoundedRectangle(cornerRadius: diameter * 0.28).strokeBorder(InstantStyle.accent, lineWidth: model.avatarIndex == index ? 3 : 0)
                            }
                    }
                    .buttonStyle(.plain)
                    .position(x: geometry.size.width * points[position].x, y: geometry.size.height * points[position].y)
                    .accessibilityLabel("\(look.name) avatar")
                    .accessibilityAddTraits(model.avatarIndex == index ? .isSelected : [])
                    .accessibilityIdentifier("onboarding.avatar.\(index)")
                }
                if model.avatarIndex == 6, let data = photoData ?? UserDefaults.standard.data(forKey: "instant.avatarPhoto"), let image = UIImage(data: data) {
                    Image(uiImage: image).resizable().scaledToFill().frame(width: diameter, height: diameter).clipShape(RoundedRectangle(cornerRadius: diameter * 0.28))
                        .overlay(RoundedRectangle(cornerRadius: diameter * 0.28).strokeBorder(InstantStyle.accent, lineWidth: 3))
                        .position(x: geometry.size.width * 0.5, y: geometry.size.height * 0.57)
                        .accessibilityLabel("Your uploaded assistant photo")
                }
            }
            .frame(maxHeight: 333)
            .padding(.horizontal, 18)
            .padding(.top, 20)
            Spacer(minLength: 24)
            HStack(spacing: 24) {
                Button { withAnimation(.easeInOut(duration: 0.25)) { styleOffset = (styleOffset + 1) % 6 } } label: {
                    Label("Try another style", systemImage: "arrow.triangle.2.circlepath")
                }
                PhotosPicker(selection: $photoSelection, matching: .images) {
                    Label("Upload a photo", systemImage: "photo")
                }
            }
            .font(.system(size: 13))
            .foregroundStyle(InstantStyle.muted)
            .padding(.bottom, 22)
            PillButton(title: "Continue") {
                model.persistProfile()
                advance(to: 6)
            }
            .accessibilityIdentifier("onboarding.avatar.continue")
            .padding(.horizontal, 38)
            .padding(.bottom, 20)
        }
    }

    private var trial: some View {
        fittingPage {
            VStack(spacing: 0) {
                HStack {
                    Spacer()
                    Button { model.completeOnboarding() } label: {
                        HStack(spacing: 5) { Text("Not now"); Image(systemName: "chevron.right") }
                            .font(.system(size: 13)).foregroundStyle(InstantStyle.muted)
                    }
                    .accessibilityIdentifier("onboarding.trial.skip")
                }
                .frame(height: 38).padding(.horizontal, 20)
                DotMark(size: 15).padding(.top, 17).padding(.bottom, 31)
                Text("We're all set.\nLet \(model.assistantName) move with your day.")
                    .font(InstantStyle.serif(24)).lineSpacing(4).multilineTextAlignment(.center)
                    .foregroundStyle(InstantStyle.forest)
                    .minimumScaleFactor(0.75).padding(.horizontal, 20)
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text("Pro").font(InstantStyle.serif(25, italic: true)).foregroundStyle(InstantStyle.forest)
                        Spacer()
                        Text("Demo preview").font(.system(size: 10)).foregroundStyle(InstantStyle.muted)
                    }
                    .padding(.bottom, 15)
                    .overlay(alignment: .bottom) {
                        Rectangle().fill(InstantStyle.accent.opacity(0.7)).frame(height: 1)
                    }
                    .padding(.bottom, 20)
                    Text("7-Day Free").font(InstantStyle.serif(39)).minimumScaleFactor(0.7).lineLimit(1)
                    Text("Then $20/month").font(.system(size: 16)).padding(.top, 4)
                    Text("Full Impo experience for everyday work.")
                        .font(.system(size: 14)).padding(.top, 31).padding(.bottom, 12)
                    Rectangle().fill(InstantStyle.border).frame(height: 0.5)
                    VStack(alignment: .leading, spacing: 13) {
                        feature("Monthly frontier AI usage included")
                        feature("Long-term memory that grows with you")
                        feature("Daily briefings and proactive follow-ups")
                        feature("Scheduled and on-demand tasks")
                    }
                    .padding(.top, 19)
                }
                .padding(30)
                .frame(maxWidth: .infinity, alignment: .leading)
                .paperSurface(cornerRadius: 18)
                .padding(.horizontal, 18)
                .padding(.top, 27)
                Spacer(minLength: 18)
                PillButton(title: "Continue") { model.completeOnboarding() }
                    .accessibilityIdentifier("onboarding.trial.continue")
                    .padding(.horizontal, 22)
                Text("Preview only · no trial starts and no payment is taken")
                    .font(.system(size: 10)).foregroundStyle(InstantStyle.muted)
                    .padding(.top, 12).padding(.bottom, 13)
            }
        }
    }

    private func feature(_ title: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "checkmark").font(.system(size: 14))
                .foregroundStyle(InstantStyle.forest)
            Text(title).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(InstantStyle.muted)
    }

    private func progressHeader(fraction: CGFloat, back: Int) -> some View {
        HStack(spacing: 28) {
            Button { advance(to: back) } label: {
                Image(systemName: "chevron.left").font(.system(size: 18, weight: .light))
                    .foregroundStyle(InstantStyle.muted).frame(width: 28, height: 38)
                    .instantGlass(cornerRadius: 13)
            }
            .accessibilityLabel("Back")
            GeometryReader { geometry in
                Capsule().fill(InstantStyle.border.opacity(0.7))
                    .overlay(alignment: .leading) {
                        Capsule().fill(InstantStyle.accent).frame(width: max(6, geometry.size.width * fraction))
                    }
            }
            .frame(height: 5)
            .accessibilityLabel("Onboarding progress")
            .accessibilityValue("\(Int(fraction * 100)) percent")
        }
        .padding(.horizontal, 22)
        .frame(height: 38)
    }
}

enum LoginBrand { case google, microsoft, apple }

private struct BrandMark: View {
    let brand: LoginBrand
    var body: some View {
        switch brand {
        case .google:
            Text("G").font(.system(size: 24, weight: .bold))
                .foregroundStyle(AngularGradient(colors: [.blue, .green, .yellow, .red, .blue], center: .center))
        case .microsoft:
            VStack(spacing: 1) {
                HStack(spacing: 1) { Color(red: 0.95, green: 0.31, blue: 0.14); Color(red: 0.49, green: 0.73, blue: 0.02) }
                HStack(spacing: 1) { Color(red: 0, green: 0.64, blue: 0.94); Color(red: 1, green: 0.73, blue: 0) }
            }
            .frame(width: 19, height: 19)
        case .apple:
            Image(systemName: "apple.logo").font(.system(size: 23))
        }
    }
}

private enum OnboardingService: String, CaseIterable, Identifiable {
    case health, calendar, reminders, contacts, google, notion
    var id: String { rawValue }
    var title: String {
        switch self {
        case .health: "Apple Health"
        case .calendar: "Apple Calendar"
        case .reminders: "Apple Reminders"
        case .contacts: "Apple Contacts"
        case .google: "Google Workspace"
        case .notion: "Notion"
        }
    }
    var detail: String {
        switch self {
        case .health: "Sleep. Recovery. Energy. Mood. I'll track and help you keep healthy."
        case .calendar: "Your time tells me everything. I'll know your rhythm from day one."
        case .reminders: "The things you told yourself not to forget. I'll make sure they actually happen."
        case .contacts: "The people in your life matter. I'll help you stay close to them."
        case .google: "Emails, meetings, files — your work, all here. I'll connect the dots."
        case .notion: "Your thinking lives here. I'll read between the lines so I can actually help."
        }
    }
    var permissionNoun: String {
        switch self {
        case .health: "health information"
        case .calendar: "calendar"
        case .reminders: "reminders"
        case .contacts: "contacts"
        case .google: "workspace"
        case .notion: "notes"
        }
    }
}

private struct ServiceMark: View {
    let service: OnboardingService
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                RoundedRectangle(cornerRadius: geometry.size.width * 0.24)
                    .fill(InstantStyle.paperElevated)
                    .overlay {
                        RoundedRectangle(cornerRadius: geometry.size.width * 0.24)
                            .strokeBorder(InstantStyle.border, lineWidth: 0.8)
                    }
                switch service {
                case .health:
                    Image(systemName: "heart.fill").font(.system(size: geometry.size.width * 0.53))
                        .foregroundStyle(LinearGradient(colors: [.pink, .red], startPoint: .top, endPoint: .bottom))
                case .calendar:
                    VStack(spacing: 0) {
                        Text("Tue").font(.system(size: geometry.size.width * 0.18, weight: .medium)).foregroundStyle(.red)
                        Text("1").font(.system(size: geometry.size.width * 0.55, weight: .light))
                    }
                case .reminders:
                    VStack(spacing: geometry.size.width * 0.1) {
                        ForEach(0..<3) { index in
                            HStack(spacing: 3) {
                                Circle().fill([Color.blue, .red, .orange][index]).frame(width: geometry.size.width * 0.13)
                                Rectangle().fill(InstantStyle.border).frame(height: 0.5)
                            }
                            .frame(height: geometry.size.width * 0.15)
                        }
                    }.padding(geometry.size.width * 0.15)
                case .contacts:
                    RoundedRectangle(cornerRadius: geometry.size.width * 0.22).fill(InstantStyle.sage)
                    Image(systemName: "person.crop.circle.fill").font(.system(size: geometry.size.width * 0.68)).foregroundStyle(InstantStyle.paperElevated)
                case .google:
                    BrandMark(brand: .google).scaleEffect(geometry.size.width / 36)
                case .notion:
                    Text("N").font(.system(size: geometry.size.width * 0.7, weight: .bold, design: .serif))
                        .frame(width: geometry.size.width * 0.67, height: geometry.size.width * 0.7)
                        .overlay(RoundedRectangle(cornerRadius: 2).strokeBorder(InstantStyle.ink, lineWidth: 1.5))
                }
            }
        }
        .accessibilityHidden(true)
    }
}
