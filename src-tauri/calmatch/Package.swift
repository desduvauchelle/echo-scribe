// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "echo-scribe-calmatch",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "echo-scribe-calmatch",
            path: ".",
            sources: ["main.swift"]
        )
    ]
)
