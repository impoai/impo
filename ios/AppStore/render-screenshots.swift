import AppKit
import SwiftUI

// Render marketing layouts around unmodified captures of the real iOS UI.
// Run from repository root: swift ios/AppStore/render-screenshots.swift
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("ios/AppStore/screenshots")
func color(_ hex: UInt32) -> Color { Color(red: Double((hex >> 16) & 255)/255, green: Double((hex >> 8) & 255)/255, blue: Double(hex & 255)/255) }
let paper = color(0xF3EDDF), forest = color(0x244E40), orange = color(0xE99B54)
struct Scene {
    let id: String, title: String, detail: String, feature: String, source: String
    let background: Color, ink: Color, accent: Color
}
let scenes = [
    Scene(id: "01", title: "A little more\nroom for life.", detail: "Your personal agent, with context.", feature: "MEET IMPO", source: "01-chat", background: forest, ink: paper, accent: orange),
    Scene(id: "02", title: "Good thoughts.\nKept close.", detail: "Speak with Echo. Return to the thought.", feature: "ECHO", source: "02-echo", background: color(0xDCE3D0), ink: forest, accent: color(0xBE7744)),
    Scene(id: "03", title: "Hand it off.\nPick it up later.", detail: "A task gets its own conversation.", feature: "TASKS", source: "03-task-detail", background: paper, ink: forest, accent: color(0xBE7744)),
    Scene(id: "04", title: "Your day.\nA little clearer.", detail: "Personal briefs, from the context you share.", feature: "BRIEF", source: "04-brief", background: color(0xEBCBA8), ink: forest, accent: color(0x876142)),
    Scene(id: "05", title: "Less repeating.\nMore remembering.", detail: "Useful context, kept close to your personal agent.", feature: "MEMORIES", source: "05-memory", background: color(0xE7E9DA), ink: forest, accent: color(0xAD7446)),
    Scene(id: "06", title: "Your context.\nYour choice.", detail: "Connect only what you choose to share.", feature: "CONNECTIONS", source: "06-connections", background: color(0x203F36), ink: paper, accent: orange)
]
struct Poster: View {
    let scene: Scene
    var body: some View {
        ZStack(alignment: .topLeading) {
            scene.background
            // An oversized, quiet orbit echoes the round orange dot in the mark.
            Circle().stroke(scene.ink.opacity(0.10), lineWidth: 0.6).frame(width: 710, height: 710).position(x: 480, y: 935)
            Circle().stroke(scene.ink.opacity(0.08), lineWidth: 0.6).frame(width: 920, height: 920).position(x: 480, y: 935)
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center) {
                    HStack(spacing: 9) {
                        Image(nsImage: NSImage(contentsOfFile: "site/assets/apple-touch-icon.png")!).resizable().frame(width: 30, height: 30).clipShape(RoundedRectangle(cornerRadius: 8))
                        Text("impo").font(.custom("Georgia", size: 29)).tracking(-1)
                    }
                    Spacer()
                    Text(scene.feature).font(.custom("AvenirNext-Medium", size: 12)).tracking(2.8)
                }.foregroundStyle(scene.ink)
                Rectangle().fill(scene.ink.opacity(0.25)).frame(height: 0.5).padding(.top, 23)
                Text(scene.title).font(.custom("Georgia", size: scene.id == "05" ? 54 : 62)).tracking(-2.6).lineSpacing(0)
                    .fixedSize(horizontal: false, vertical: true).foregroundStyle(scene.ink).padding(.top, 34)
                HStack(spacing: 10) {
                    Circle().fill(scene.accent).frame(width: 7, height: 7)
                    Text(scene.detail).font(.custom("AvenirNext-Regular", size: 18)).tracking(-0.2).foregroundStyle(scene.ink.opacity(0.85))
                }.padding(.top, 21)
            }.padding(.horizontal, 46).padding(.top, 48).frame(width: 660)
            Image(nsImage: NSImage(contentsOf: root.appendingPathComponent("source/\(scene.source).png"))!)
                .resizable().aspectRatio(contentMode: .fit).frame(width: 458)
                .clipShape(RoundedRectangle(cornerRadius: 31, style: .continuous))
                .padding(6).background(color(0x273B34), in: RoundedRectangle(cornerRadius: 38, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 38, style: .continuous).stroke(scene.ink.opacity(0.25), lineWidth: 0.75))
                .shadow(color: Color.black.opacity(0.20), radius: 22, x: 0, y: 19)
                .position(x: 330, y: 875)
            HStack {
                Text("A LITTLE MORE ROOM FOR LIFE").tracking(2)
                Spacer()
                Text("\(scene.id) / 06").tracking(2)
            }.font(.custom("AvenirNext-Medium", size: 9)).foregroundStyle(scene.ink.opacity(0.70))
                .padding(.horizontal, 46).frame(width: 660).offset(y: 1395)
        }.frame(width: 660, height: 1434, alignment: .topLeading).clipped()
    }
}
@MainActor func render<V: View>(_ view: V, scale: CGFloat, path: URL) throws {
    let renderer = ImageRenderer(content: view)
    renderer.scale = scale
    renderer.isOpaque = true
    guard let cg = renderer.cgImage else { fatalError("Could not render") }
    let rep = NSBitmapImageRep(cgImage: cg)
    guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("Could not encode PNG") }
    try png.write(to: path)
}
try MainActor.assumeIsolated {
    for scene in scenes {
        let path = root.appendingPathComponent("iphone-6.9/\(scene.id)-\(scene.feature.lowercased().replacingOccurrences(of: " ", with: "-")).png")
        try render(Poster(scene: scene), scale: 2, path: path)
        print(path.path)
    }
    try render(HStack(spacing: 12) { ForEach(0..<scenes.count, id: \.self) { i in Image(nsImage: NSImage(contentsOf: root.appendingPathComponent("iphone-6.9/\(scenes[i].id)-\(scenes[i].feature.lowercased().replacingOccurrences(of: " ", with: "-")).png"))!).resizable().frame(width: 297, height: 645.3) } }.padding(20).background(color(0xC6C5B9)), scale: 1, path: root.appendingPathComponent("contact-sheet.png"))
}
