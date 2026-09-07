import Observation
import SwiftUI
import UIKit
import XCTest
@testable import OpenClawChatUI

private struct ComposerTransport: OpenClawChatTransport {
    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        throw CancellationError()
    }

    func sendMessage(
        sessionKey: String, message: String, thinking: String, idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw CancellationError()
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool { false }
    func events() -> AsyncStream<OpenClawChatTransportEvent> { AsyncStream { $0.finish() } }
}

@MainActor @Observable
private final class ComposerSettings {
    var focusRequested = true
    var enabled = true
    var revision = 0
    var height: CGFloat { 44 + CGFloat(self.revision) * 10 }
}

@MainActor
private struct ComposerRoot: View {
    @Bindable var model: OpenClawChatViewModel
    let settings: ComposerSettings

    var body: some View {
        ChatComposerTextViewIOS(
            text: self.$model.input,
            focusRequested: self.settings.focusRequested,
            isEnabled: self.settings.enabled,
            minHeight: self.settings.height,
            maxHeight: 160,
            onFocusChange: { _ in },
            onHistoryUp: { _ in false },
            onHistoryDown: { false })
            .frame(width: 320, height: self.settings.height)
    }
}

@MainActor
final class ComposerCompatibilityTests: XCTestCase {
    private var window: UIWindow?
    private var model: OpenClawChatViewModel?
    private var settings: ComposerSettings?
    private var editor: ChatComposerUITextView?
    private var snapshots: [[String: Any]] = []
    private var scenario = ""
    private var emitted = false

    override func setUp() {
        super.setUp()
        self.continueAfterFailure = true
        self.snapshots = []
        self.emitted = false
    }

    override func tearDown() {
        if !self.emitted { self.finish("invalid", "unexpected-interruption") }
        self.editor?.resignFirstResponder()
        self.window?.isHidden = true
        self.window?.rootViewController = nil
        self.model?.detachTransport()
        self.editor = nil
        self.window = nil
        self.model = nil
        self.settings = nil
        super.tearDown()
    }

    func testExternalReplaceAndClear() {
        guard self.mount("external", text: "draft"), let model = self.model, let editor = self.editor else { return }
        model.input = "replacement"
        guard self.require(self.wait { editor.text == "replacement" }, "replace"),
              self.require(editor.isFirstResponder && editor.selectedRange == NSRange(location: 11, length: 0), "replace-selection")
        else { return }
        editor.insertText("!")
        guard self.require(self.wait { editor.text == "replacement!" && model.input == "replacement!" }, "replace-continued-input")
        else { return }
        self.snapshot("replaced-and-edited")
        model.input = ""
        guard self.require(self.wait { editor.text == "" }, "clear"),
              self.require(editor.isFirstResponder && editor.selectedRange == NSRange(location: 0, length: 0), "clear-selection")
        else { return }
        editor.insertText("x")
        guard self.require(self.wait { editor.text == "x" && model.input == "x" }, "clear-continued-input") else { return }
        self.snapshot("cleared-and-edited")
        self.finish("passed", "complete")
    }

    func testCaretAndSelectionEcho() {
        guard self.mount("selection", text: "abcde"), let model = self.model, let editor = self.editor else { return }
        for (range, replacement, expected, resultRange) in [
            (NSRange(location: 2, length: 0), "X", "abXcdef", NSRange(location: 3, length: 0)),
            (NSRange(location: 1, length: 3), "Y", "aYef", NSRange(location: 2, length: 0)),
        ] {
            model.input = "abcde"
            guard self.require(self.wait { editor.text == "abcde" }, "independent-selection-setup") else { return }
            editor.selectedRange = NSRange(location: 5, length: 0)
            editor.insertText("f")
            guard self.require(self.wait { editor.text == "abcdef" && model.input == "abcdef" }, "native-echo") else { return }
            editor.selectedRange = range
            guard self.require(editor.selectedRange == range, "selection-setup"), self.refresh(),
                  self.require(editor.text == "abcdef" && model.input == "abcdef"
                    && editor.selectedRange == range && editor.isFirstResponder, "selection-preserved")
            else { return }
            self.snapshot(range.length == 0 ? "caret-after-refresh" : "selection-after-refresh")
            editor.insertText(replacement)
            guard self.require(self.wait { editor.text == expected && model.input == expected }, "selection-continued-input"),
                  self.require(editor.selectedRange == resultRange && editor.isFirstResponder, "selection-result")
            else { return }
            self.snapshot(range.length == 0 ? "caret-after-insertion" : "selection-after-replacement")
        }
        self.finish("passed", "complete")
    }

    func testMarkedTextRefreshAndCommit() {
        guard self.mount("marked", text: "ab"), let model = self.model, let editor = self.editor else { return }
        editor.selectedRange = NSRange(location: 1, length: 0)
        editor.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
        guard self.require(self.wait {
            guard let marked = editor.markedTextRange else { return false }
            return editor.text(in: marked) == "に" && editor.text == "aにb" && model.input == "aにb"
        }, "native-marked-text") else { return }
        let selected = editor.selectedRange
        guard let markedBefore = self.markedRange() else {
            _ = self.require(false, "marked-range-before")
            return
        }
        self.snapshot("marked-before-refresh")
        guard self.refresh(),
              self.require(editor.markedTextRange != nil && self.markedRange() == markedBefore
                && editor.selectedRange == selected && editor.text == "aにb" && model.input == "aにb"
                && editor.isFirstResponder, "marked-preserved")
        else { return }
        self.snapshot("marked-after-refresh")
        editor.unmarkText()
        guard self.require(editor.markedTextRange == nil && editor.text == "aにb" && model.input == "aにb", "marked-commit")
        else { return }
        editor.insertText("!")
        guard self.require(self.wait { editor.text == "aに!b" && model.input == "aに!b" }, "marked-continued-input"),
              self.require(editor.markedTextRange == nil && editor.selectedRange == NSRange(location: 3, length: 0), "committed-selection")
        else { return }
        self.snapshot("committed-and-edited")
        self.finish("passed", "complete")
    }

    func testFalseFocusAndDisabled() {
        guard self.mount("focus", text: "draft"), let settings = self.settings,
              let model = self.model, let editor = self.editor
        else { return }
        settings.focusRequested = false
        guard self.refresh(),
              self.require(editor.isFirstResponder && editor.isEditable && editor.isSelectable && editor.text == "draft", "false-is-not-blur")
        else { return }
        self.snapshot("false-focus-request")
        settings.enabled = false
        guard self.require(self.wait { !editor.isEditable && !editor.isSelectable && !editor.isFirstResponder }, "disabled-blurs"),
              self.require(editor.text == "draft" && model.input == "draft", "disabled-preserves-text")
        else { return }
        self.snapshot("disabled")
        settings.enabled = true
        guard self.require(self.wait { editor.isEditable && editor.isSelectable }, "reenabled"),
              self.require(!editor.isFirstResponder, "reenabled-without-focus")
        else { return }
        settings.focusRequested = true
        guard self.require(self.wait { editor.isFirstResponder }, "explicit-refocus") else { return }
        editor.selectedRange = NSRange(location: 5, length: 0)
        editor.insertText("!")
        guard self.require(self.wait { editor.text == "draft!" && model.input == "draft!" }, "refocused-input") else { return }
        self.snapshot("refocused-and-edited")
        self.finish("passed", "complete")
    }

    private func mount(_ scenario: String, text: String) -> Bool {
        self.scenario = scenario
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard self.require(scenes.count == 1, "one-owned-scene"), let scene = scenes.first else { return false }
        let model = OpenClawChatViewModel(sessionKey: "agent:main:composer-contract", transport: ComposerTransport())
        model.input = text
        let settings = ComposerSettings()
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: ComposerRoot(model: model, settings: settings))
        self.model = model
        self.settings = settings
        self.window = window
        window.makeKeyAndVisible()
        guard self.require(self.wait {
            let editors = self.findEditors(in: window)
            if editors.count == 1 { self.editor = editors[0] }
            return editors.count == 1 && editors[0].isFirstResponder && editors[0].text == text
        }, "real-representable-mounted") else { return false }
        self.snapshot("mounted")
        return true
    }

    private func findEditors(in view: UIView) -> [ChatComposerUITextView] {
        (view as? ChatComposerUITextView).map { [$0] } ?? view.subviews.flatMap { self.findEditors(in: $0) }
    }

    private func refresh() -> Bool {
        guard let settings = self.settings, let editor = self.editor else { return false }
        settings.revision += 1
        return self.require(self.wait { abs(editor.bounds.height - settings.height) < 0.5 }, "real-layout-refresh")
    }

    private func markedRange() -> NSRange? {
        guard let editor = self.editor, let range = editor.markedTextRange else { return nil }
        return NSRange(location: editor.offset(from: editor.beginningOfDocument, to: range.start),
                       length: editor.offset(from: range.start, to: range.end))
    }

    private func wait(_ predicate: @escaping () -> Bool) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in predicate() }, object: nil)
        return XCTWaiter.wait(for: [expectation], timeout: 3) == .completed
    }

    private func require(_ condition: Bool, _ phase: String, file: StaticString = #filePath, line: UInt = #line) -> Bool {
        guard condition else {
            self.snapshot("failed-" + phase)
            self.finish("failed", phase)
            XCTFail("COMPOSER_COMPAT_ASSERT \(self.scenario) \(phase)", file: file, line: line)
            return false
        }
        return true
    }

    private func snapshot(_ phase: String) {
        guard let editor = self.editor, let model = self.model, let window = self.window else { return }
        let marked = self.markedRange()
        self.snapshots.append([
            "phase": phase, "text": editor.text ?? "", "binding": model.input,
            "selectedLocation": String(editor.selectedRange.location), "selectedLength": String(editor.selectedRange.length),
            "markedLocation": marked.map { String($0.location) } ?? "none",
            "markedLength": marked.map { String($0.length) } ?? "none",
            "firstResponder": editor.isFirstResponder, "editable": editor.isEditable, "selectable": editor.isSelectable,
        ])
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = "composer-compat-\(self.scenario)-\(phase)"
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }

    private func finish(_ outcome: String, _ phase: String) {
        guard !self.emitted else { return }
        self.emitted = true
        let record: [String: Any] = [
            "version": 1, "scenario": self.scenario, "outcome": outcome, "phase": phase,
            "snapshots": self.snapshots, "pid": ProcessInfo.processInfo.processIdentifier,
            "bundleID": Bundle.main.bundleIdentifier ?? "missing",
        ]
        let data = try! JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
        let json = String(decoding: data, as: UTF8.self)
        print("COMPOSER_COMPAT_RECORD \(json)")
        let attachment = XCTAttachment(string: json)
        attachment.name = "composer-compat-\(self.scenario).json"
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }
}
