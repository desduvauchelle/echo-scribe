// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "echo-scribe-syscap",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "echo-scribe-syscap",
            path: ".",
            sources: ["main.swift"]
        )
    ]
)
