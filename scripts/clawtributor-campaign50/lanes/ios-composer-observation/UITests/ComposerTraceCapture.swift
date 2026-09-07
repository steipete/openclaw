import CoreFoundation
import Foundation
import XCTest

@MainActor
enum ComposerTraceCapture {
    private final class Receiver {
        let expectation = XCTestExpectation(description: "post-case composer trace acknowledgement")
        var acknowledgedAt: TimeInterval?

        func receive() {
            guard self.acknowledgedAt == nil else { return }
            self.acknowledgedAt = ProcessInfo.processInfo.systemUptime
            self.expectation.fulfill()
        }
    }

    private static var receivers: [String: Receiver] = [:]

    static func drain(nonce: String, scenario: String, test: XCTestCase) {
        guard UUID(uuidString: nonce) != nil else { return }
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let ackKey = "org.openclaw.tests.focus136179.composer.\(nonce).ack"
        let ack = CFNotificationName(rawValue: ackKey as CFString)
        let request = CFNotificationName(rawValue: "org.openclaw.tests.focus136179.composer.\(nonce).request" as CFString)
        let receiver = Receiver()
        self.receivers[ackKey] = receiver
        let registeringAt = ProcessInfo.processInfo.systemUptime
        CFNotificationCenterAddObserver(center, nil, { _, _, name, _, _ in
            guard let name else { return }
            let key = name.rawValue as String
            Task { @MainActor in ComposerTraceCapture.receivers[key]?.receive() }
        }, ack.rawValue, nil, .deliverImmediately)
        let registeredAt = ProcessInfo.processInfo.systemUptime
        let postedAt = ProcessInfo.processInfo.systemUptime
        CFNotificationCenterPostNotification(center, request, nil, nil, false)
        let waitStartedAt = ProcessInfo.processInfo.systemUptime
        let result = XCTWaiter.wait(for: [receiver.expectation], timeout: 3)
        let finishedAt = ProcessInfo.processInfo.systemUptime
        CFNotificationCenterRemoveObserver(center, nil, ack, nil)
        self.receivers.removeValue(forKey: ackKey)
        var record: [String: Any] = [
            "version": 1, "nonce": nonce, "scenario": scenario,
            "registeringAt": registeringAt, "registeredAt": registeredAt, "postedAt": postedAt,
            "waitStartedAt": waitStartedAt, "finishedAt": finishedAt, "timeoutSeconds": 3,
            "resultRawValue": result.rawValue, "acknowledged": result == .completed,
        ]
        if let time = receiver.acknowledgedAt { record["acknowledgedAt"] = time }
        do {
            let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
            let json = String(decoding: data, as: UTF8.self)
            print("COMPOSER_CAPTURE \(json)")
            let attachment = XCTAttachment(string: json)
            attachment.name = "composer-capture-\(scenario).json"
            attachment.lifetime = .keepAlways
            test.add(attachment)
        } catch {
            print("COMPOSER_CAPTURE_ERROR serialization")
        }
    }
}
