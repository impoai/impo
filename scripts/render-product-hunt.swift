import AppKit
import SwiftUI

// Compose launch artwork around unchanged app captures.
// Run from the repository root: swift scripts/render-product-hunt.swift
let base = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let kit = base.appendingPathComponent("docs/product-hunt")
func color(_ value: UInt32) -> Color {
    Color(red: Double(value >> 16 & 255) / 255, green: Double(value >> 8 & 255) / 255, blue: Double(value & 255) / 255)
}
let paper = color(0xF3EDDF), forest = color(0x244E40), orange = color(0xE69A59)
struct Scene {
    let id: String, eyebrow: String, title: String, detail: String, note: String
    let screens: [String]
    let dark: Bool
    var background: Color { dark ? forest : paper }
    var ink: Color { dark ? paper : forest }
}
let scenes = [
    Scene(id: "01-meet-impo", eyebrow: "YOUR PERSONAL AGENT", title: "A little more\nroom for life.", detail: "Remember what matters.\nGet things done.\nFind your next good buy.", note: "Start on the web · impo.ai/app", screens: ["chat", "shopping-results"], dark: true),
    Scene(id: "02-shopping", eyebrow: "SHOPPING · START WITH WHAT YOU NEED", title: "Your needs.\nYour budget.\nYour next buy.", detail: "Find products, compare options,\nand explore the details together.", note: "Browse in Impo. Complete your purchase at the merchant.", screens: ["shopping-results", "shopping-detail"], dark: false),
    Scene(id: "03-echo", eyebrow: "ECHO · CAPTURE THE MOMENT", title: "Good thoughts.\nKept close.", detail: "Start Echo on your phone.\nReturn to your words as a transcript.\nChoose which speech is yours.", note: "Recording starts when you choose.", screens: ["echo"], dark: false),
    Scene(id: "04-memory", eyebrow: "MEMORY · CONTEXT YOU CONTROL", title: "Less repeating.\nMore remembering.", detail: "Useful context from your conversations\nand confirmed Echo speech.\nBrowse it. Keep it. Forget it.", note: "Personal context for a more useful next conversation.", screens: ["memory"], dark: true),
    Scene(id: "05-tasks", eyebrow: "TASKS · HAND IT OFF", title: "Give the work\nits own space.", detail: "Research, plan, or get a first draft.\nCome back to the result.\nSchedule work that repeats.", note: "Server-side work continues when you leave the app.", screens: ["task"], dark: false),
    Scene(id: "06-feed", eyebrow: "FEED · FOLLOW THROUGH", title: "A little\nperspective\nfor your day.", detail: "Useful next steps, shaped by\nthe context you choose to share.", note: "Real Web interface · sample account content", screens: ["web-feed"], dark: false),
    Scene(id: "07-your-choice", eyebrow: "CONNECTIONS · SOURCE AVAILABLE", title: "Your context.\nYour choice.", detail: "Connect the services you need.\nChoose your phone permissions.\nExplore the clients and backend.", note: "github.com/impoai/impo", screens: ["connections"], dark: true),
    Scene(id: "08-start", eyebrow: "MEET IMPO", title: "What can we\nhelp with today?", detail: "Try the Web app.\nGet the Android app.\nHelp shape your personal agent.", note: "impo.ai/app · iOS TestFlight public access pending", screens: ["chat"], dark: false),
]

struct Capture: View {
    let name: String
    let width: CGFloat
    var body: some View {
        Image(nsImage: NSImage(contentsOf: kit.appendingPathComponent("source/\(name).png"))!)
            .resizable().aspectRatio(contentMode: .fit).frame(width: width)
            .clipShape(RoundedRectangle(cornerRadius: name == "web-feed" ? 10 : 22))
            .padding(4).background(color(0x263F35), in: RoundedRectangle(cornerRadius: name == "web-feed" ? 14 : 26))
            .shadow(color: .black.opacity(0.16), radius: 13, x: 0, y: 10)
    }
}

struct Poster: View {
    let scene: Scene
    var body: some View {
        ZStack(alignment: .topLeading) {
            scene.background
            Circle().stroke(scene.ink.opacity(0.10), lineWidth: 1).frame(width: 760, height: 760).offset(x: 790, y: 280)
            Circle().stroke(scene.ink.opacity(0.07), lineWidth: 1).frame(width: 970, height: 970).offset(x: 685, y: 175)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 11) {
                    Image(nsImage: NSImage(contentsOf: base.appendingPathComponent("site/assets/apple-touch-icon.png"))!)
                        .resizable().frame(width: 38, height: 38).clipShape(RoundedRectangle(cornerRadius: 9))
                    Text("impo").font(.custom("Georgia", size: 36)).tracking(-1.4)
                    Spacer()
                    Text(scene.eyebrow).font(.custom("AvenirNext-Medium", size: 12)).tracking(2.0)
                }.foregroundStyle(scene.ink)
                Rectangle().fill(scene.ink.opacity(0.25)).frame(height: 1).padding(.top, 22)
            }.padding(.horizontal, 58).padding(.top, 36)

            VStack(alignment: .leading, spacing: 26) {
                Text(scene.title).font(.custom("Georgia", size: scene.id == "04-memory" ? 55 : scene.id == "06-feed" ? 52 : 64))
                    .tracking(-2.2).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
                Rectangle().fill(orange).frame(width: 45, height: 4)
                Text(scene.detail).font(.custom("AvenirNext-Regular", size: 22)).lineSpacing(8)
                    .fixedSize(horizontal: false, vertical: true).foregroundStyle(scene.ink.opacity(0.9))
            }.foregroundStyle(scene.ink).frame(width: scene.id == "06-feed" ? 500 : 550, alignment: .leading)
                .offset(x: 58, y: scene.id == "06-feed" ? 145 : 168)

            if scene.screens.count == 2 {
                Capture(name: scene.screens[0], width: 242).rotationEffect(.degrees(-4)).position(x: 773, y: 390)
                Capture(name: scene.screens[1], width: 249).rotationEffect(.degrees(4)).position(x: 1060, y: 429)
            } else if scene.screens[0] == "web-feed" {
                Capture(name: "web-feed", width: 680).position(x: 872, y: 414)
            } else {
                Capture(name: scene.screens[0], width: 267).position(x: 955, y: 408)
            }
            VStack(spacing: 18) {
                Rectangle().fill(scene.ink.opacity(0.25)).frame(height: 1)
                HStack(alignment: .center) {
                    Text(scene.note).font(.custom("AvenirNext-Medium", size: 14))
                    Spacer()
                    Text(scene.id == "02-shopping" ? "CATALOG PRICES SHOWN ARE SNAPSHOTS" : "REAL APP CAPTURES · SAMPLE PERSONAL CONTENT")
                        .font(.custom("AvenirNext-Regular", size: 8)).tracking(0.8)
                    Text(String(scene.id.prefix(2)) + " / 08").font(.custom("AvenirNext-Medium", size: 10)).tracking(2).padding(.leading, 17)
                }
            }.foregroundStyle(scene.ink.opacity(0.85)).padding(.horizontal, 58).offset(y: 700)
        }.frame(width: 1270, height: 760, alignment: .topLeading).clipped()
    }
}

@MainActor func render<V: View>(_ view: V, scale: CGFloat = 1, path: URL) throws {
    let renderer = ImageRenderer(content: view)
    renderer.scale = scale
    renderer.isOpaque = true
    guard let cg = renderer.cgImage,
          let data = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else { fatalError("Rendering failed") }
    try data.write(to: path)
}
try MainActor.assumeIsolated {
    for scene in scenes {
        try render(Poster(scene: scene), path: kit.appendingPathComponent("assets/\(scene.id).png"))
    }
    let icon = Image(nsImage: NSImage(contentsOf: base.appendingPathComponent("ios/App/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png"))!)
        .resizable().frame(width: 240, height: 240)
    try render(icon, path: kit.appendingPathComponent("assets/thumbnail-240.png"))
    try render(VStack(spacing: 16) {
        ForEach(0..<4) { row in
            HStack(spacing: 16) {
                ForEach(0..<2) { column in
                    Image(nsImage: NSImage(contentsOf: kit.appendingPathComponent("assets/\(scenes[row * 2 + column].id).png"))!)
                        .resizable().frame(width: 635, height: 380)
                }
            }
        }
    }.padding(16).background(color(0xC7C8BA)), path: kit.appendingPathComponent("assets/contact-sheet.png"))
    print("Rendered eight 1270 × 760 gallery images, a thumbnail and a contact sheet.")
}
