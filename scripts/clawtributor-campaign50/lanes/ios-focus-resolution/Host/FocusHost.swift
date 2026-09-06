import Foundation
import Observation
import OpenClawChatUI
import OpenClawProtocol
import SwiftUI

enum FocusScenario: String {
    case secure, text, hosts, passive
}

@MainActor @Observable
final class FixtureStatus {
    var history = false
    var sessions = false
    var models = false
    var questions = false
    var health = false
    var effects = 0

    var ready: Bool { self.history && self.sessions && self.models && self.questions && self.health }
}

struct FocusTransport: OpenClawChatTransport {
    let status: FixtureStatus
    let record: QuestionRecord?
    let passiveMessage = AnyCodable([
        "role": AnyCodable("assistant"),
        "content": AnyCodable([["type": "text", "text": "PASSIVE FOCUS CONTROL"]]),
        "timestamp": AnyCodable(Int64(1_700_000_000_000)),
    ])

    @MainActor
    init(scenario: FocusScenario, status: FixtureStatus) {
        self.status = status
        let now = Int(Date().timeIntervalSince1970 * 1000)
        self.record = scenario == .passive ? nil : QuestionRecord(
            id: "focus-fixture-\(scenario.rawValue)",
            questions: [Question(
                questionid: "answer",
                header: "Focus fixture \(scenario.rawValue)",
                question: "Synthetic input focus check",
                options: [],
                isother: true,
                issecret: scenario != .text,
                secretstore: scenario == .hosts ? QuestionSecretStoreBinding(
                    name: "SYNTHETIC_FOCUS_VALUE",
                    kind: AnyCodable("secret"),
                    reason: "Test input only; never submitted.") : nil)],
            agentid: "main",
            sessionkey: "agent:main:main",
            runid: "focus-fixture-run",
            createdatms: now,
            expiresatms: now + 600_000,
            status: .pending)
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        await MainActor.run { self.status.history = true }
        return OpenClawChatHistoryPayload(
            sessionKey: sessionKey,
            sessionId: "focus-session",
            messages: self.record == nil ? [self.passiveMessage] : [],
            thinkingLevel: "off")
    }

    func listSessions(limit: Int?, search: String?, archived: Bool) async throws -> OpenClawChatSessionsListResponse {
        await MainActor.run { self.status.sessions = true }
        return OpenClawChatSessionsListResponse(ts: 0, path: "fixture", count: 0, defaults: nil, sessions: [])
    }

    func listModels(agentID: String?) async throws -> [OpenClawChatModelChoice] {
        await MainActor.run { self.status.models = true }
        return [.init(modelID: "gpt-5.6-sol", name: "Fixture model", provider: "openai", available: true, contextWindow: 128_000)]
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        await MainActor.run { self.status.health = true }
        return true
    }

    func gatewayAdvertisesMethod(_ method: String) async -> Bool? { method == "question.list" }

    func listQuestions() async throws -> [QuestionRecord] {
        await MainActor.run { self.status.questions = true }
        return self.record.map { [$0] } ?? []
    }

    func sendMessage(
        sessionKey: String, message: String, thinking: String, idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        await MainActor.run { self.status.effects += 1 }
        throw CancellationError()
    }

    func resolveQuestion(
        id: String, answers: [String: [String]], secretStoreAllowedHosts: [String]?) async throws -> QuestionAnswers
    {
        await MainActor.run { self.status.effects += 1 }
        throw CancellationError()
    }

    func cancelQuestion(id: String) async throws {
        await MainActor.run { self.status.effects += 1 }
        throw CancellationError()
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> { AsyncStream { $0.finish() } }
}

@main @MainActor
struct FocusHostApp: App {
    @State private var status: FixtureStatus
    @State private var model: OpenClawChatViewModel
    private let scenario: FocusScenario

    init() {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "--focus-scenario"), args.indices.contains(index + 1),
              let scenario = FocusScenario(rawValue: args[index + 1])
        else { fatalError("A named test scenario is required") }
        self.scenario = scenario
        let status = FixtureStatus()
        self._status = State(initialValue: status)
        self._model = State(initialValue: OpenClawChatViewModel(
            sessionKey: "agent:main:main",
            transport: FocusTransport(scenario: scenario, status: status),
            activeAgentId: "main"))
    }

    var body: some Scene {
        WindowGroup {
            VStack(spacing: 0) {
                HStack {
                    Text(self.scenario.rawValue).accessibilityIdentifier("focus-scenario")
                    Text(self.model.errorText == nil ? "none" : "error").accessibilityIdentifier("focus-bootstrap-error")
                    Text(self.status.ready && !self.model.isLoading ? "ready" : "loading")
                        .accessibilityIdentifier("focus-bootstrap")
                    Text(String(self.status.effects)).accessibilityIdentifier("focus-effects")
                }
                .font(.caption2)
                OpenClawChatView(
                    viewModel: self.model,
                    showsSessionSwitcher: false,
                    showsAssistantAvatars: false,
                    composerChrome: .clean,
                    isComposerEnabled: true,
                    isAttachmentInputEnabled: true)
                    .environment(\.openClawAssistantBubblesInCleanChrome, true)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
        }
    }
}
