import SwiftUI

// MARK: - Card Style

struct CardStyleModifier: ViewModifier {
    let isSelected: Bool
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content
            .padding(Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Radius.md)
                    .fill(AppColors.surface)
            )
            .overlay(alignment: .leading) {
                if isSelected {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.accentColor)
                        .frame(width: 4)
                        .padding(.vertical, Spacing.sm)
                }
            }
            .modifier(Elevation.card(colorScheme))
    }
}

// MARK: - Pill Style

struct PillStyleModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .font(.caption2)
            .padding(.horizontal, Spacing.sm)
            .padding(.vertical, Spacing.xs)
            .background(Color.accentColor.opacity(0.08), in: Capsule())
            .foregroundStyle(Color.accentColor)
    }
}

// MARK: - Section Label

struct SectionLabelModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .font(.caption)
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
            .tracking(0.5)
    }
}

// MARK: - Page Container

struct PageContainerModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .frame(maxWidth: AppLayout.contentMaxWidth)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, Spacing.xl)
    }
}

// MARK: - Gentle Appear

struct GentleAppearModifier: ViewModifier {
    @State private var isVisible = false

    func body(content: Content) -> some View {
        content
            .opacity(isVisible ? 1 : 0)
            .offset(y: isVisible ? 0 : 8)
            .onAppear {
                withAnimation(AppAnimation.gentle) {
                    isVisible = true
                }
            }
    }
}

// MARK: - Ghost Button

struct GhostButtonModifier: ViewModifier {
    let isActive: Bool
    @State private var isHovered = false

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, Spacing.sm + 2)
            .padding(.vertical, Spacing.xs + 1)
            .background(
                RoundedRectangle(cornerRadius: Radius.sm)
                    .fill(isActive ? Color.accentColor.opacity(0.12) : (isHovered ? AppColors.surfaceHover : Color.clear))
            )
            .foregroundStyle(isActive ? Color.accentColor : .secondary)
            .onHover { hovering in
                isHovered = hovering
            }
    }
}

// MARK: - Search Field Style

struct SearchFieldStyleModifier: ViewModifier {
    @FocusState private var isFocused: Bool

    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .padding(Spacing.sm + 2)
            .background(
                RoundedRectangle(cornerRadius: Radius.md)
                    .fill(AppColors.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Radius.md)
                    .strokeBorder(isFocused ? Color.accentColor : Color.clear, lineWidth: 1.5)
            )
            .focused($isFocused)
    }
}

// MARK: - View Extensions

extension View {
    func cardStyle(isSelected: Bool = false) -> some View {
        modifier(CardStyleModifier(isSelected: isSelected))
    }

    func pillStyle() -> some View {
        modifier(PillStyleModifier())
    }

    func sectionLabel() -> some View {
        modifier(SectionLabelModifier())
    }

    func pageContainer() -> some View {
        modifier(PageContainerModifier())
    }

    func gentleAppear() -> some View {
        modifier(GentleAppearModifier())
    }

    func ghostButton(isActive: Bool = false) -> some View {
        modifier(GhostButtonModifier(isActive: isActive))
    }

    func searchFieldStyle() -> some View {
        modifier(SearchFieldStyleModifier())
    }
}
