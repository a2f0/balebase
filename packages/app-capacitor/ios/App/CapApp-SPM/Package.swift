// swift-tools-version: 6.0
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v18)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.6.0"),
        .package(name: "CapacitorApp", path: "../../../../../node_modules/.bun/@capacitor+app@8.1.2+6ab6186627aac117/node_modules/@capacitor/app"),
        .package(name: "CapacitorFilesystem", path: "../../../../../node_modules/.bun/@capacitor+filesystem@8.1.5+6ab6186627aac117/node_modules/@capacitor/filesystem"),
        .package(name: "CapacitorNetwork", path: "../../../../../node_modules/.bun/@capacitor+network@8.0.1+6ab6186627aac117/node_modules/@capacitor/network"),
        .package(name: "CapacitorShare", path: "../../../../../node_modules/.bun/@capacitor+share@8.0.3+6ab6186627aac117/node_modules/@capacitor/share")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorFilesystem", package: "CapacitorFilesystem"),
                .product(name: "CapacitorNetwork", package: "CapacitorNetwork"),
                .product(name: "CapacitorShare", package: "CapacitorShare")
            ]
        )
    ]
)
