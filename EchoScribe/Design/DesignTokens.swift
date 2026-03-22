import SwiftUI

// MARK: - Spacing Scale (4pt base grid)

enum Spacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 16
    static let lg: CGFloat = 24
    static let xl: CGFloat = 32
    static let xxl: CGFloat = 48
}

// MARK: - Corner Radius

enum Radius {
    static let sm: CGFloat = 6
    static let md: CGFloat = 10
    static let lg: CGFloat = 16
}

// MARK: - Colors

enum AppColors {
    static let surface = Color(nsColor: .controlBackgroundColor)
    static let surfaceHover = Color(nsColor: .unemphasizedSelectedContentBackgroundColor)
    static let border = Color(nsColor: .separatorColor)
}

// MARK: - Elevation

enum Elevation {
    static func card(_ colorScheme: ColorScheme) -> some ViewModifier {
        CardElevation(colorScheme: colorScheme)
    }

    static func float(_ colorScheme: ColorScheme) -> some ViewModifier {
        FloatElevation(colorScheme: colorScheme)
    }
}

struct CardElevation: ViewModifier {
    let colorScheme: ColorScheme

    func body(content: Content) -> some View {
        if colorScheme == .dark {
            content
                .overlay(
                    RoundedRectangle(cornerRadius: Radius.md)
                        .strokeBorder(AppColors.border, lineWidth: 1)
                )
        } else {
            content
                .shadow(color: .black.opacity(0.04), radius: 3, y: 1)
        }
    }
}

struct FloatElevation: ViewModifier {
    let colorScheme: ColorScheme

    func body(content: Content) -> some View {
        if colorScheme == .dark {
            content
                .shadow(color: .black.opacity(0.3), radius: 8, y: 2)
        } else {
            content
                .shadow(color: .black.opacity(0.10), radius: 12, y: 4)
        }
    }
}

// MARK: - Animation

enum AppAnimation {
    static let gentle = Animation.easeInOut(duration: 0.25)
    static let quick = Animation.easeOut(duration: 0.15)
}

// MARK: - Layout

enum AppLayout {
    static let contentMaxWidth: CGFloat = 720
}
