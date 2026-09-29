// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "InstantClient",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "InstantClient", targets: ["InstantClient"])],
    targets: [
        .target(name: "InstantClient"),
        .testTarget(name: "InstantClientTests", dependencies: ["InstantClient"]),
    ]
)
