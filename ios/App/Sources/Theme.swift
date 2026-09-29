import SwiftUI

enum InstantStyle {
    static let ink = Color(red: 0.16, green: 0.24, blue: 0.18)
    static let muted = Color(red: 0.43, green: 0.43, blue: 0.35)
    static let forest = Color(red: 0.15, green: 0.30, blue: 0.24)
    static let accent = Color(red: 0.88, green: 0.57, blue: 0.30)
    static let paper = Color(red: 0.957, green: 0.933, blue: 0.890)
    static let paperElevated = Color(red: 0.988, green: 0.973, blue: 0.933)
    static let border = Color(red: 0.83, green: 0.78, blue: 0.67)
    static let sage = Color(red: 0.77, green: 0.83, blue: 0.72)
    static let orangePaper = Color(red: 0.96, green: 0.70, blue: 0.44)
    // Kept for existing call sites; the original cool palette is retired.
    static let blue = sage
    static let peach = Color(red: 0.97, green: 0.84, blue: 0.66)

    static func serif(_ size: CGFloat, weight: Font.Weight = .regular, italic: Bool = false) -> Font {
        let face = italic ? "Georgia-Italic" : (weight == .bold || weight == .semibold ? "Georgia-Bold" : "Georgia")
        return .custom(face, size: size, relativeTo: size >= 24 ? .title : .body)
    }
}

struct InstantBackground: View {
    var body: some View {
        InstantStyle.paper
            .overlay(alignment: .top) {
                LinearGradient(colors: [InstantStyle.paperElevated.opacity(0.6), .clear], startPoint: .top, endPoint: .bottom)
                    .frame(height: 400)
            }
            .ignoresSafeArea()
            .accessibilityHidden(true)
    }
}

/// The mark replaces the former paired dots without changing its callers.
struct DotMark: View {
    var vertical = false
    var size: CGFloat = 15
    var body: some View {
        Image("InstantMark").resizable().scaledToFit()
            .frame(width: size * 3, height: size * 3)
            .accessibilityHidden(true)
    }
}

/// Raw values preserve saved choices; 3 remains the default Impo mark and 6 is a custom photo.
enum AssistantLook: Int, CaseIterable {
    case fox = 0, robin, cat, impo, owl, otter

    static let choices: [Self] = [.impo, .fox, .robin, .cat, .owl, .otter]

    var name: String {
        switch self {
        case .impo: "Impo"
        case .fox: "Fox"
        case .robin: "Robin"
        case .cat: "Cat"
        case .owl: "Owl"
        case .otter: "Otter"
        }
    }

    var asset: String { self == .impo ? "InstantMark" : "Avatar\(name)" }
}

struct AssistantAvatar: View {
    var index: Int = 3
    var size: CGFloat = 40
    private var look: AssistantLook { AssistantLook(rawValue: index) ?? .impo }
    var body: some View {
        Group {
            if index == 6, let data = UserDefaults.standard.data(forKey: "instant.avatarPhoto"), let image = UIImage(data: data) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                ZStack {
                    InstantStyle.paperElevated
                    Image(look.asset)
                        .resizable().scaledToFit().padding(look == .impo ? size * 0.05 : 0)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous).strokeBorder(InstantStyle.border.opacity(0.7), lineWidth: 0.6))
        .accessibilityHidden(true)
    }
}

private struct PaperSurface: ViewModifier {
    var cornerRadius: CGFloat
    func body(content: Content) -> some View {
        content
            .background {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(InstantStyle.paperElevated)
                    .shadow(color: InstantStyle.border.opacity(0.22), radius: 0, x: 1, y: 2)
            }
            .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).strokeBorder(InstantStyle.border.opacity(0.85), lineWidth: 0.7).allowsHitTesting(false))
    }
}

private struct InstantGlassSurface: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var cornerRadius: CGFloat
    var tint: Color?

    @ViewBuilder func body(content: Content) -> some View {
        if reduceTransparency {
            content
                .background(InstantStyle.paperElevated, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).strokeBorder(InstantStyle.border, lineWidth: 1))
        } else if #available(iOS 26.0, *) {
            content.glassEffect(.regular.tint(tint), in: .rect(cornerRadius: cornerRadius))
        } else {
            content.background {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(.regularMaterial)
                    .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).fill((tint ?? InstantStyle.paperElevated).opacity(0.25)))
            }
            .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).strokeBorder(InstantStyle.paperElevated.opacity(0.9), lineWidth: 1))
            .shadow(color: InstantStyle.forest.opacity(0.08), radius: 8, y: 3)
        }
    }
}

extension View {
    func paperSurface(cornerRadius: CGFloat = 18) -> some View {
        modifier(PaperSurface(cornerRadius: cornerRadius))
    }
    func instantGlass(cornerRadius: CGFloat = 24, tint: Color? = nil) -> some View {
        modifier(InstantGlassSurface(cornerRadius: cornerRadius, tint: tint))
            .contentShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }
}

struct PillButton: View {
    var title: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 18, weight: .medium)).foregroundStyle(InstantStyle.ink)
                .frame(maxWidth: .infinity).frame(minHeight: 54)
                .instantGlass(cornerRadius: 27, tint: InstantStyle.accent.opacity(0.3))
        }.buttonStyle(PressStyle())
    }
}

struct PressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.7 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(.easeOut(duration: 0.16), value: configuration.isPressed)
    }
}

// Existing content-card call sites now render paper; glass is reserved for controls.
struct GlassCard<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        content.padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .paperSurface(cornerRadius: 18)
    }
}

struct CircleButton: View {
    var symbol: String
    var label: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 20, weight: .regular))
                .frame(width: 44, height: 44)
                .instantGlass(cornerRadius: 22)
        }.foregroundStyle(InstantStyle.ink).buttonStyle(PressStyle()).accessibilityLabel(label)
    }
}

struct BackHeader: View {
    var title: String
    var onBack: () -> Void
    var body: some View {
        HStack {
            CircleButton(symbol: "chevron.left", label: "Back", action: onBack)
            Spacer()
            Text(title).font(InstantStyle.serif(25))
            Spacer()
            Color.clear.frame(width: 44, height: 44)
        }.padding(.horizontal, 18).padding(.vertical, 8)
    }
}

struct ScenarioIllustration: View {
    var symbol: String
    private var asset: String? {
        switch symbol {
        case "folder": "SceneWork"
        case "calendar.badge.clock": "SceneSchedule"
        case "dumbbell": "SceneHealth"
        case "chart.xyaxis.line": "SceneFinance"
        case "airplane.ticket": "SceneTravel"
        default: nil
        }
    }
    var body: some View {
        Group {
            if let asset { Image(asset).resizable().scaledToFit() }
            else {
                Image(systemName: symbol).font(.system(size: 27, weight: .light))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(InstantStyle.forest, InstantStyle.accent)
            }
        }.accessibilityHidden(true)
    }
}
