import XCTest

@MainActor
final class FocusUITests: XCTestCase {
    private var app: XCUIApplication!
    private var scenario = ""
    private var observations: [[String: Any]] = []
    private var setupLabelReads: [[String: Any]] = []
    private var waitResults: [[String: Any]] = []
    private var emitted = false
    private var composerTraceNonce = ""

    override func setUp() {
        super.setUp()
        self.continueAfterFailure = true
        self.observations = []
        self.setupLabelReads = []
        self.waitResults = []
        self.emitted = false
    }

    override func tearDown() {
        if !self.emitted { self.finish("invalid", "unexpected-interruption") }
        ComposerTraceCapture.drain(nonce: self.composerTraceNonce, scenario: self.scenario, test: self)
        self.app?.terminate()
        super.tearDown()
    }

    func testSecureFocus() { self.checkField("secure", label: "Secret value", secure: true) }
    func testTextFocus() { self.checkField("text", label: "Other answer", secure: false) }
    func testAllowedHostsFocus() { self.checkField("hosts", label: "Allowed HTTPS hosts", secure: false) }

    private func launch(_ scenario: String) -> Bool {
        self.scenario = scenario
        self.app = XCUIApplication(bundleIdentifier: "org.openclaw.tests.focus136179")
        self.composerTraceNonce = UUID().uuidString.lowercased()
        self.app.launchArguments = ["--focus-scenario", scenario, "--composer-observation-nonce", self.composerTraceNonce]
        self.app.launch()
        return self.require(self.app.state == .runningForeground, "setup-foreground")
            && self.require(self.wait {
                let started = ProcessInfo.processInfo.systemUptime
                let label = self.app.staticTexts["focus-scenario"].label
                let finished = ProcessInfo.processInfo.systemUptime
                self.setupLabelReads.append([
                    "startedAt": started,
                    "finishedAt": finished,
                    "elapsedSeconds": finished - started,
                    "actualLabel": label,
                    "expectedLabel": scenario,
                    "matches": label == scenario,
                ])
                return label == scenario
            }, "setup-scenario")
            && self.require(self.wait(8) { self.app.staticTexts["focus-bootstrap"].label == "ready" }, "setup-bootstrap")
            && self.require(self.app.staticTexts["focus-bootstrap-error"].label == "none", "setup-error")
            && self.require(self.app.staticTexts["focus-effects"].label == "0", "setup-effects")
    }

    private func checkField(_ scenario: String, label: String, secure: Bool) {
        guard self.launch(scenario) else { return }
        let field: XCUIElement
        if secure {
            field = self.app.secureTextFields[label]
        } else {
            let inputs = self.app.descendants(matching: .any).matching(NSPredicate(
                format: "(elementType == %d OR elementType == %d) AND label == %@",
                XCUIElement.ElementType.textField.rawValue,
                XCUIElement.ElementType.textView.rawValue,
                label))
            guard self.require(inputs.count == 1, "setup-field-count") else { return }
            field = inputs.firstMatch
        }
        let submit = self.app.buttons["Submit"]
        guard self.require(field.exists && field.isEnabled && field.isHittable, "setup-field"),
              self.require(submit.exists && !submit.isEnabled, "setup-empty-answer"),
              self.require(self.countdowns.count == 1, "setup-countdown")
        else { return }
        self.capture("ready")
        self.observe("ready", field: field)

        field.tap()
        self.observe("first-tap", field: field)
        guard self.require(self.keyboard.waitForExistence(timeout: 3), "first-tap-focus") else { return }
        self.observe("first-tap-focused", field: field)
        field.tap()
        self.observe("retap", field: field)
        guard self.require(self.keyboard.exists, "retap-focus") else { return }

        let before = self.countdowns.firstMatch.label
        guard self.require(self.waitForTick(after: before), "countdown-progress") else { return }
        self.observe("post-tick", field: field)
        self.capture("post-tick")
        guard self.require(self.keyboard.exists, "post-tick-focus") else { return }

        // Do not tap here: another tap could hide focus loss during the real timeline update.
        let value = scenario == "hosts" ? "api.example.com" : "synthetic-focus-probe"
        field.typeText(value)
        self.observe("typed", field: field)
        guard self.require(self.keyboard.exists, "typed-focus") else { return }
        if scenario == "hosts" {
            guard self.require(field.value as? String == value, "hosts-value") else { return }
            let typedCountdown = self.countdowns.firstMatch.label
            guard self.require(self.waitForTick(after: typedCountdown), "hosts-countdown-progress"),
                  self.require(field.value as? String == value, "hosts-value-after-tick"),
                  self.require(self.keyboard.exists, "hosts-post-tick-focus"),
                  self.require(!submit.isEnabled, "hosts-not-an-answer")
            else { return }
            self.observe("hosts-post-tick", field: field)
        } else {
            guard self.require(self.wait { submit.isEnabled }, "answer-enabled") else { return }
            if !secure {
                guard self.require(field.value as? String == value, "answer-value") else { return }
            }
        }
        guard self.require(self.app.staticTexts["focus-effects"].label == "0", "no-side-effects") else { return }
        self.capture("typed")
        self.finish("passed", "complete")
    }

    func testPassiveDismissal() {
        guard self.launch("passive") else { return }
        let field = self.app.descendants(matching: .any)["chat-message-input"]
        let passive = self.app.staticTexts["PASSIVE FOCUS CONTROL"]
        guard self.require(field.exists && field.isHittable && field.isEnabled, "setup-composer"),
              self.require(passive.exists && passive.isHittable, "setup-passive-region")
        else { return }
        field.tap()
        guard self.require(self.keyboard.waitForExistence(timeout: 3), "control-keyboard") else { return }
        let draft = "retained draft"
        field.typeText(draft)
        guard self.require(field.value as? String == draft, "control-draft"),
              self.require(passive.isHittable && passive.frame.maxY < self.keyboard.frame.minY, "control-passive-region")
        else { return }
        self.capture("passive-before")
        self.observe("passive-before", field: field)
        passive.tap()
        guard self.require(self.keyboard.waitForNonExistence(timeout: 3), "control-dismiss"),
              self.require(field.value as? String == draft, "control-retained-draft"),
              self.require(self.app.staticTexts["focus-effects"].label == "0", "no-side-effects")
        else { return }
        self.observe("passive-after", field: field)
        self.capture("passive-after")
        self.finish("passed", "complete")
    }

    private var keyboard: XCUIElement { self.app.keyboards.firstMatch }

    private var countdowns: XCUIElementQuery {
        self.app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "[0-9]+:[0-5][0-9]"))
    }

    private func wait(_ timeout: TimeInterval = 3, _ predicate: @escaping () -> Bool) -> Bool {
        let started = ProcessInfo.processInfo.systemUptime
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in predicate() }, object: nil)
        let waitStarted = ProcessInfo.processInfo.systemUptime
        let result = XCTWaiter.wait(for: [expectation], timeout: timeout)
        let finished = ProcessInfo.processInfo.systemUptime
        self.waitResults.append([
            "timeoutSeconds": timeout,
            "startedAt": started,
            "waitStartedAt": waitStarted,
            "finishedAt": finished,
            "waitElapsedSeconds": finished - waitStarted,
            "totalElapsedSeconds": finished - started,
            "result": String(describing: result),
            "resultRawValue": result.rawValue,
        ])
        return result == .completed
    }

    private func waitForTick(after label: String) -> Bool {
        self.wait { self.countdowns.count == 1 && self.countdowns.firstMatch.label != label }
    }

    private func require(_ condition: Bool, _ phase: String, file: StaticString = #filePath, line: UInt = #line) -> Bool {
        guard condition else {
            self.capture("failed-\(phase)")
            self.finish("failed", phase)
            XCTFail("FOCUS_ASSERT \(self.scenario) \(phase)", file: file, line: line)
            return false
        }
        return true
    }

    private func observe(_ phase: String, field: XCUIElement) {
        self.observations.append([
            "phase": phase,
            "keyboard": self.keyboard.exists,
            "fieldEnabled": field.isEnabled,
            "fieldHittable": field.isHittable,
            "value": field.value as? String ?? "<none>",
            "countdown": self.countdowns.count == 1 ? self.countdowns.firstMatch.label : "<none>",
            "submitEnabled": self.app.buttons["Submit"].exists ? self.app.buttons["Submit"].isEnabled : false,
        ])
    }

    private func capture(_ phase: String) {
        guard self.app != nil else { return }
        let screenshot = XCTAttachment(screenshot: self.app.screenshot())
        screenshot.name = "focus-\(self.scenario)-\(phase)"
        screenshot.lifetime = .keepAlways
        self.add(screenshot)
    }

    private func finish(_ outcome: String, _ phase: String) {
        guard !self.emitted else { return }
        self.emitted = true
        let record: [String: Any] = [
            "version": 1,
            "scenario": self.scenario,
            "outcome": outcome,
            "phase": phase,
            "observations": self.observations,
            "setupLabelReads": self.setupLabelReads,
            "waitResults": self.waitResults,
            "foreground": self.app?.state == .runningForeground,
            "sideEffects": self.app?.staticTexts["focus-effects"].exists == true
                ? self.app.staticTexts["focus-effects"].label : "<missing>",
            "bootstrapError": self.app?.staticTexts["focus-bootstrap-error"].exists == true
                ? self.app.staticTexts["focus-bootstrap-error"].label : "<missing>",
        ]
        let data = try! JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
        let json = String(decoding: data, as: UTF8.self)
        print("FOCUS_RECORD \(json)")
        let attachment = XCTAttachment(string: json)
        attachment.name = "focus-result-\(self.scenario).json"
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }
}
