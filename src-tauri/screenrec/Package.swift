// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "echo-scribe-screenrec",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "echo-scribe-screenrec",
            path: ".",
            sources: ["main.swift", "InputEvents.swift"]
        )
    ]
)
