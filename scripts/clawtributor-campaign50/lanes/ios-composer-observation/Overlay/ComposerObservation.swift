#if os(iOS)
import CoreFoundation
import Foundation
import UIKit

@MainActor
final class ComposerObservation {
    enum Event: String, Encodable {
        case initial, beginEditing, endEditing, proposedEdit, selectionChanged
        case didChange, update, measure
        case bindingBefore, bindingAfter, textBefore, textAfter
        case selectionBefore, selectionAfter, echoReturn, ignoredReturn, fittingReturned
    }

    struct RangeValue: Encodable {
        let location: String
        let length: String

        init(_ range: NSRange) {
            self.location = String(range.location)
            self.length = String(range.length)
        }
    }

    struct Record: Encodable {
        let sequence: Int
        let uptime: TimeInterval
        let event: Event
        let phase: String
        let span: Int?
        let parentSpan: Int?
        let depth: Int
        let view: Int
        let uiText: String
        let uiTextUTF16Length: Int
        let binding: String?
        let lastReported: String?
        let replacement: String?
        let selection: RangeValue
        let proposedRanges: [RangeValue]
        let isFirstResponder: Bool
        let hasMarkedText: Bool
        let isProgrammaticUpdate: Bool?
        let proposedWidth: Double?
        let fittingWidth: Double?
        let fittingHeight: Double?
    }

    private struct Span {
        let id: Int
        let parent: Int?
        let event: Event
    }

    private struct Envelope: Encodable {
        let version = 1
        let nonce: String
        let pid: Int32
        let scenario: String
        let sealed = true
        let finalDepth: Int
        let finalSequence: Int
        let overflow: Bool
        let incomplete: Bool
        let breachedLimit: String?
        let stoppedPayloads: Int
        let maximumRecords = 2048
        let maximumDepth = 32
        let maximumUTF16Units = 64
        let maximumRanges = 8
        let maximumBytes = 8 * 1024 * 1024
        let records: [Record]
    }

    private static var instance: ComposerObservation?
    private let nonce: String
    private let scenario: String
    private var records: [Record] = []
    private var spans: [Span] = []
    private struct ViewIdentity {
        weak var view: UITextView?
        let ordinal: Int
    }

    private var views: [ObjectIdentifier: ViewIdentity] = [:]
    private var nextView = 0
    private var nextSpan = 0
    private var estimatedBytes = 4096
    private var active = false
    private var pendingDrain = false
    private var sealed = false
    private var breachedLimit: String?
    private var stoppedPayloads = 0

    static func install() {
        guard self.instance == nil else { return }
        let arguments = ProcessInfo.processInfo.arguments
        func argument(_ name: String) -> String? {
            guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return nil }
            return arguments[index + 1]
        }
        guard let nonce = argument("--composer-observation-nonce"), UUID(uuidString: nonce) != nil,
              let scenario = argument("--focus-scenario"), ["secure", "text", "hosts", "passive"].contains(scenario)
        else { return }
        self.instance = ComposerObservation(nonce: nonce, scenario: scenario)
    }

    private init(nonce: String, scenario: String) {
        self.nonce = nonce
        self.scenario = scenario
        self.records.reserveCapacity(2048)
        let name = "org.openclaw.tests.focus136179.composer.\(nonce).request" as CFString
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, _, _, _ in
            Task { @MainActor in ComposerObservation.instance?.requestDrain() }
        }, name, nil, .deliverImmediately)
    }

    static func enter(
        _ event: Event, view: UITextView, binding: String?, lastReported: String?, programmatic: Bool?,
        replacement: String? = nil, ranges: [NSValue] = [], width: CGFloat? = nil,
        activate: Bool = false
    ) -> Int? {
        guard let owner = self.instance, !owner.sealed else { return nil }
        if activate { owner.active = true }
        guard owner.active else { return nil }
        guard owner.spans.count < 32 else {
            owner.stop("depth")
            return nil
        }
        owner.nextSpan += 1
        let span = Span(id: owner.nextSpan, parent: owner.spans.last?.id, event: event)
        owner.spans.append(span)
        owner.record(event, phase: "enter", span: span, view: view, binding: binding,
                     lastReported: lastReported, programmatic: programmatic,
                     replacement: replacement, ranges: ranges, width: width)
        return span.id
    }

    static func leave(
        _ id: Int?, view: UITextView, binding: String?, lastReported: String?, programmatic: Bool?
    ) {
        guard let owner = self.instance, let id else { return }
        guard let span = owner.spans.last, span.id == id else {
            owner.stop("span-order")
            return
        }
        owner.record(span.event, phase: "exit", span: span, view: view, binding: binding,
                     lastReported: lastReported, programmatic: programmatic)
        owner.spans.removeLast()
        owner.drainIfReady()
    }

    static func point(
        _ event: Event, view: UITextView, binding: String?, lastReported: String?, programmatic: Bool?,
        width: CGFloat? = nil, fitting: CGSize? = nil
    ) {
        guard let owner = self.instance, !owner.sealed, owner.active || event == .initial else { return }
        owner.record(event, phase: "point", span: owner.spans.last, view: view, binding: binding,
                     lastReported: lastReported, programmatic: programmatic, width: width, fitting: fitting)
    }

    private func stop(_ limit: String) {
        if self.breachedLimit == nil { self.breachedLimit = limit }
        self.stoppedPayloads += 1
    }

    private func record(
        _ event: Event, phase: String, span: Span?, view: UITextView, binding: String?,
        lastReported: String?, programmatic: Bool?, replacement: String? = nil,
        ranges: [NSValue] = [], width: CGFloat? = nil, fitting: CGSize? = nil
    ) {
        guard self.breachedLimit == nil else { self.stoppedPayloads += 1; return }
        guard self.records.count < 2048 else { self.stop("records"); return }
        guard ranges.count + 1 <= 8 else { self.stop("ranges"); return }
        // Four bounded strings, eight integer ranges and fixed scalars fit within this conservative reservation.
        guard self.estimatedBytes + 4096 <= 8 * 1024 * 1024 else { self.stop("bytes"); return }
        let text = view.text ?? ""
        guard [text, binding, lastReported, replacement].allSatisfy({ ($0?.utf16.count ?? 0) <= 64 }) else {
            self.stop("text")
            return
        }
        let identity = ObjectIdentifier(view)
        let ordinal: Int
        if let previous = self.views[identity], previous.view === view {
            ordinal = previous.ordinal
        } else {
            guard self.nextView < 2048 else { self.stop("views"); return }
            self.nextView += 1
            ordinal = self.nextView
            self.views[identity] = ViewIdentity(view: view, ordinal: ordinal)
        }
        self.estimatedBytes += 4096
        self.records.append(Record(
            sequence: self.records.count + 1, uptime: ProcessInfo.processInfo.systemUptime,
            event: event, phase: phase, span: span?.id, parentSpan: span?.parent,
            depth: self.spans.count, view: ordinal, uiText: text, uiTextUTF16Length: text.utf16.count,
            binding: binding, lastReported: lastReported, replacement: replacement,
            selection: RangeValue(view.selectedRange), proposedRanges: ranges.map { RangeValue($0.rangeValue) },
            isFirstResponder: view.isFirstResponder, hasMarkedText: view.markedTextRange != nil,
            isProgrammaticUpdate: programmatic, proposedWidth: width.map(Double.init),
            fittingWidth: fitting.map { Double($0.width) }, fittingHeight: fitting.map { Double($0.height) }))
    }

    private func requestDrain() {
        guard !self.sealed else { return }
        self.pendingDrain = true
        self.drainIfReady()
    }

    private func drainIfReady() {
        guard self.pendingDrain, !self.sealed, self.spans.isEmpty else { return }
        self.sealed = true
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.nonConformingFloatEncodingStrategy = .convertToString(
            positiveInfinity: "+infinity", negativeInfinity: "-infinity", nan: "nan")
        let envelope = Envelope(
            nonce: self.nonce, pid: ProcessInfo.processInfo.processIdentifier, scenario: self.scenario,
            finalDepth: self.spans.count, finalSequence: self.records.count,
            overflow: self.breachedLimit != nil, incomplete: self.breachedLimit != nil,
            breachedLimit: self.breachedLimit, stoppedPayloads: self.stoppedPayloads, records: self.records)
        do {
            let data = try encoder.encode(envelope)
            guard data.count <= 8 * 1024 * 1024 else { self.stop("bytes"); return }
            let file = FileManager.default.temporaryDirectory
                .appendingPathComponent("composer-observation-\(self.nonce).json")
            guard !FileManager.default.fileExists(atPath: file.path) else { return }
            try data.write(to: file, options: .atomic)
            let name = CFNotificationName(rawValue: "org.openclaw.tests.focus136179.composer.\(self.nonce).ack" as CFString)
            CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), name, nil, nil, false)
        } catch {
            // Capture failure deliberately produces no success acknowledgement.
        }
    }
}
#endif
