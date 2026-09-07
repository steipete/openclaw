#if os(iOS)
import SwiftUI
import UIKit

@MainActor
struct ChatComposerTextViewIOS: UIViewRepresentable {
    @Binding var text: String
    var focusRequested: Bool
    var isEnabled: Bool
    var minHeight: CGFloat
    var maxHeight: CGFloat
    var onFocusChange: (Bool) -> Void
    var onHistoryUp: (Bool) -> Bool
    var onHistoryDown: () -> Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> ChatComposerUITextView {
        let textView = ChatComposerTextViewIOSFactory.makeConfiguredTextView()
        textView.delegate = context.coordinator
        textView.text = self.text
        self.configureHistoryHandlers(textView)
        ComposerObservation.point(.initial, view: textView, binding: self.text, lastReported: context.coordinator.lastReportedText, programmatic: context.coordinator.isProgrammaticUpdate)
        return textView
    }

    func updateUIView(_ textView: ChatComposerUITextView, context: Context) {
        let observation = ComposerObservation.enter(.update, view: textView, binding: self.text, lastReported: context.coordinator.lastReportedText, programmatic: context.coordinator.isProgrammaticUpdate)
        defer { ComposerObservation.leave(observation, view: textView, binding: self.text, lastReported: context.coordinator.lastReportedText, programmatic: context.coordinator.isProgrammaticUpdate) }
        context.coordinator.parent = self
        textView.isEditable = self.isEnabled
        textView.isSelectable = self.isEnabled
        self.configureHistoryHandlers(textView)

        // UIKit owns user-initiated focus. A false focus request is not a blur request;
        // conflating the two cancels a tap before SwiftUI observes first-responder state.
        if self.focusRequested, self.isEnabled, !textView.isFirstResponder {
            textView.becomeFirstResponder()
        } else if !self.isEnabled, textView.isFirstResponder {
            textView.resignFirstResponder()
        }

        let isEcho = context.coordinator.lastReportedText == self.text
        if textView.isFirstResponder, isEcho {
            ComposerObservation.point(.echoReturn, view: textView, binding: self.text, lastReported: context.coordinator.lastReportedText, programmatic: context.coordinator.isProgrammaticUpdate)
            return
        }

        if textView.text != self.text {
            context.coordinator.isProgrammaticUpdate = true
            defer { context.coordinator.isProgrammaticUpdate = false }
            ComposerObservation.point(.textBefore, view: textView, binding: self.text, lastReported: context.coordinator.lastReportedText, programmatic: context.coordinator.isProgrammaticUpdate)
            textView.text = self.text
            ComposerObservation.point(.textAfter, view: textView, binding: self.text, lastReported: context.coordinator.lastReportedText, programmatic: context.coordinator.isProgrammaticUpdate)
            if textView.isFirstResponder {
                ComposerObservation.point(.selectionBefore, view: textView, binding: self.text, lastReported: context.coordinator.lastReportedText, programmatic: context.coordinator.isProgrammaticUpdate)
                textView.selectedRange = NSRange(location: (self.text as NSString).length, length: 0)
                ComposerObservation.point(.selectionAfter, view: textView, binding: self.text, lastReported: context.coordinator.lastReportedText, programmatic: context.coordinator.isProgrammaticUpdate)
            }
            textView.invalidateIntrinsicContentSize()
        }
        context.coordinator.lastReportedText = self.text
    }

    private func configureHistoryHandlers(_ textView: ChatComposerUITextView) {
        textView.onHistoryUp = self.onHistoryUp
        textView.onHistoryDown = self.onHistoryDown
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: ChatComposerUITextView,
        context: Context) -> CGSize?
    {
        guard let width = proposal.width else { return nil }
        let observation = ComposerObservation.enter(.measure, view: uiView, binding: self.text, lastReported: context.coordinator.lastReportedText, programmatic: context.coordinator.isProgrammaticUpdate, width: width)
        defer { ComposerObservation.leave(observation, view: uiView, binding: self.text, lastReported: context.coordinator.lastReportedText, programmatic: context.coordinator.isProgrammaticUpdate) }
        let fitting = uiView.sizeThatFits(
            CGSize(width: width, height: CGFloat.greatestFiniteMagnitude))
        ComposerObservation.point(.fittingReturned, view: uiView, binding: self.text, lastReported: context.coordinator.lastReportedText, programmatic: context.coordinator.isProgrammaticUpdate, width: width, fitting: fitting)
        return CGSize(
            width: width,
            height: min(max(fitting.height, self.minHeight), self.maxHeight))
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ChatComposerTextViewIOS
        var isProgrammaticUpdate = false
        var lastReportedText: String?

        init(_ parent: ChatComposerTextViewIOS) {
            self.parent = parent
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            let observation = ComposerObservation.enter(.beginEditing, view: textView, binding: self.parent.text, lastReported: self.lastReportedText, programmatic: self.isProgrammaticUpdate, activate: true)
            defer { ComposerObservation.leave(observation, view: textView, binding: self.parent.text, lastReported: self.lastReportedText, programmatic: self.isProgrammaticUpdate) }
            self.parent.onFocusChange(true)
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            let observation = ComposerObservation.enter(.endEditing, view: textView, binding: self.parent.text, lastReported: self.lastReportedText, programmatic: self.isProgrammaticUpdate)
            defer { ComposerObservation.leave(observation, view: textView, binding: self.parent.text, lastReported: self.lastReportedText, programmatic: self.isProgrammaticUpdate) }
            self.parent.onFocusChange(false)
        }

        @available(iOS 26.0, *)
        func textView(_ textView: UITextView, shouldChangeTextInRanges ranges: [NSValue], replacementText text: String) -> Bool {
            let observation = ComposerObservation.enter(.proposedEdit, view: textView, binding: self.parent.text, lastReported: self.lastReportedText, programmatic: self.isProgrammaticUpdate, replacement: text, ranges: ranges)
            defer { ComposerObservation.leave(observation, view: textView, binding: self.parent.text, lastReported: self.lastReportedText, programmatic: self.isProgrammaticUpdate) }
            return true
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            let observation = ComposerObservation.enter(.selectionChanged, view: textView, binding: self.parent.text, lastReported: self.lastReportedText, programmatic: self.isProgrammaticUpdate)
            defer { ComposerObservation.leave(observation, view: textView, binding: self.parent.text, lastReported: self.lastReportedText, programmatic: self.isProgrammaticUpdate) }
        }

        func textViewDidChange(_ textView: UITextView) {
            let observation = ComposerObservation.enter(.didChange, view: textView, binding: self.parent.text, lastReported: self.lastReportedText, programmatic: self.isProgrammaticUpdate)
            defer { ComposerObservation.leave(observation, view: textView, binding: self.parent.text, lastReported: self.lastReportedText, programmatic: self.isProgrammaticUpdate) }
            guard !self.isProgrammaticUpdate, textView.isFirstResponder else {
                ComposerObservation.point(.ignoredReturn, view: textView, binding: self.parent.text, lastReported: self.lastReportedText, programmatic: self.isProgrammaticUpdate)
                return
            }
            self.lastReportedText = textView.text
            ComposerObservation.point(.bindingBefore, view: textView, binding: self.parent.text, lastReported: self.lastReportedText, programmatic: self.isProgrammaticUpdate)
            self.parent.text = textView.text
            ComposerObservation.point(.bindingAfter, view: textView, binding: self.parent.text, lastReported: self.lastReportedText, programmatic: self.isProgrammaticUpdate)
            textView.invalidateIntrinsicContentSize()
        }
    }
}

@MainActor
final class ChatComposerUITextView: UITextView {
    var onHistoryUp: ((Bool) -> Bool)?
    var onHistoryDown: (() -> Bool)?

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var unhandledPresses = presses
        for press in presses {
            guard let key = press.key else { continue }
            if self.handleHardwareKey(key.keyCode, modifierFlags: key.modifierFlags) {
                unhandledPresses.remove(press)
            }
        }
        guard !unhandledPresses.isEmpty else { return }
        super.pressesBegan(unhandledPresses, with: event)
    }

    /// Internal for focused responder-level keyboard routing coverage.
    func handleHardwareKey(
        _ keyCode: UIKeyboardHIDUsage,
        modifierFlags: UIKeyModifierFlags) -> Bool
    {
        let commandModifiers: UIKeyModifierFlags = [.shift, .control, .alternate, .command]
        guard modifierFlags.isDisjoint(with: commandModifiers) else { return false }
        switch keyCode {
        case .keyboardUpArrow:
            return self.onHistoryUp?(self.caretOnFirstLine) == true
        case .keyboardDownArrow:
            return self.onHistoryDown?() == true
        default:
            return false
        }
    }

    private var caretOnFirstLine: Bool {
        let location = min(max(self.selectedRange.location, 0), (self.text as NSString).length)
        let prefix = (self.text as NSString).substring(to: location)
        return !prefix.contains("\n") && !prefix.contains("\r")
    }
}

enum ChatComposerTextViewIOSFactory {
    /// Internal for @testable import coverage of native multiline input defaults.
    @MainActor
    static func makeConfiguredTextView() -> ChatComposerUITextView {
        ComposerObservation.install()
        let textView = ChatComposerUITextView()
        textView.backgroundColor = .clear
        textView.font = OpenClawChatTypography.bodyUIFont
        textView.adjustsFontForContentSizeCategory = true
        textView.allowsEditingTextAttributes = false
        textView.isScrollEnabled = true
        textView.showsVerticalScrollIndicator = false
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.returnKeyType = .default
        textView.accessibilityIdentifier = "chat-message-input"
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return textView
    }
}
#endif
