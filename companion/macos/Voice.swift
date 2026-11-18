// Forever AI Companion silent "voice" for macOS: a speech synthesis provider
// (an Audio Unit app extension, macOS 13+) that produces no sound. WoW for Mac
// speaks with AVSpeechSynthesizer, which lists the voices of every provider
// installed on the Mac; when the game "reads" text with this voice, the text
// is handed to the app instead (as a file in its data folder), like the SAPI
// voice does on Windows (tts/ForeverAICompanionTts.cs).
//
// It lives inside the app bundle (Contents/PlugIns) and runs sandboxed: the
// only place it may write is the app's data folder, through a temporary
// sandbox exception (see voice.entitlements). The sandbox checks the real
// path of every write, so a link planted in that folder can't send the
// voice's writes anywhere else (on Windows the engine checks that itself).
//
// The voice is listed system-wide, so any program can speak with it. Because
// of that, only the app's own messages are handed over (requests and the
// addon's voice test); any other text is dropped and never written or logged.
import AVFoundation
import AudioToolbox
import Foundation

@objc(ForeverAICompanionVoiceFactory)
public class ForeverAICompanionVoiceFactory: NSObject, AUAudioUnitFactory {
    var unit: AUAudioUnit?

    public func beginRequest(with context: NSExtensionContext) {}

    public func createAudioUnit(with componentDescription: AudioComponentDescription) throws -> AUAudioUnit {
        let u = try SilentVoiceUnit(componentDescription: componentDescription, options: [])
        unit = u
        return u
    }
}

// The real home folder (inside the sandbox NSHomeDirectory() is the container).
private func realHome() -> String {
    if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir { return String(cString: dir) }
    return NSHomeDirectory()
}

private let dataDir = realHome() + "/Library/Application Support/ForeverAICompanion"
private let maxText = 200_000 // the game sends at most ~30 000 characters per phrase
private var counter = 0
private let lock = NSLock()

// Requests: "FAIC:<id>:<part>/<parts>:<base64>". The addon's voice test:
// "FAIC-VOICE-TEST ..." / "FAIC-VOICE-LONG ...".
private let request = try! NSRegularExpression(pattern: "^\\s*(?:FAIC|AZIA):[^:\\s]{1,64}:\\d{1,4}/\\d{1,4}:[A-Za-z0-9+/=\\s]*$")
private let voiceTest = try! NSRegularExpression(pattern: "^\\s*FAIC-VOICE-(?:TEST|LONG) [A-Za-z0-9 ]*$")

private func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
    re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
}

func isOurs(_ text: String) -> Bool {
    text.count <= maxText && (matches(request, text) || matches(voiceTest, text))
}

// SSML -> the plain text that was meant to be spoken (tags dropped, entities decoded).
func plainText(fromSSML ssml: String) -> String {
    var out = ""
    var inTag = false
    for ch in ssml {
        if ch == "<" { inTag = true; continue }
        if ch == ">" { inTag = false; continue }
        if !inTag { out.append(ch) }
    }
    return out
        .replacingOccurrences(of: "&lt;", with: "<")
        .replacingOccurrences(of: "&gt;", with: ">")
        .replacingOccurrences(of: "&quot;", with: "\"")
        .replacingOccurrences(of: "&apos;", with: "'")
        .replacingOccurrences(of: "&amp;", with: "&")
}

// Creates `dir` when missing (one level: the sandbox doesn't let the voice
// look at the folders above its own).
private func ensureDir(_ dir: String) -> String? {
    var st = stat()
    if stat(dir, &st) == 0 { return (st.st_mode & S_IFMT) == S_IFDIR ? dir : nil }
    if mkdir(dir, 0o755) == 0 || errno == EEXIST { return dir }
    return nil
}

// Writes a new file (never through an existing file or link).
private func writeNew(_ path: String, _ data: Data) -> Bool {
    let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    if fd < 0 { return false }
    defer { close(fd) }
    return data.withUnsafeBytes { buf in write(fd, buf.baseAddress, buf.count) == buf.count }
}

// Diagnostics: tts-engine.log in the data folder (small, rotated). Never the spoken text itself.
private func log(_ msg: String) {
    guard let dir = ensureDir(dataDir) else { return }
    let file = dir + "/tts-engine.log"
    if let size = (try? FileManager.default.attributesOfItem(atPath: file))?[.size] as? Int, size > 200_000 {
        try? FileManager.default.removeItem(atPath: file)
    }
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
    let line = "\(f.string(from: Date())) [voice] \(msg)\n"
    let fd = open(file, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0o600)
    if fd < 0 { return }
    defer { close(fd) }
    let bytes = Array(line.utf8)
    _ = write(fd, bytes, bytes.count)
}

private func deliver(_ text: String) {
    guard let dir = ensureDir(dataDir + "/tts-inbox") else {
        log("could not create the inbox folder")
        return
    }
    lock.lock()
    counter += 1
    let n = counter
    lock.unlock()
    // Same naming as on Windows: sortable by time.
    let ticks = UInt64(Date().timeIntervalSince1970 * 10_000_000)
    let name = String(format: "%020llu-%06d", ticks, n)
    let tmp = dir + "/" + name + ".tmp"
    let final = dir + "/" + name + ".txt"
    if !writeNew(tmp, Data(text.utf8)) || rename(tmp, final) != 0 {
        unlink(tmp)
        log("could not write a message (error \(errno))")
    }
}

final class SilentVoiceUnit: AVSpeechSynthesisProviderAudioUnit {
    private let format = AVAudioFormat(standardFormatWithSampleRate: 22050, channels: 1)!
    private var outBus: AUAudioUnitBus
    private var busses: AUAudioUnitBusArray!
    // Frames of silence left for the current request (a short "utterance").
    private var remaining = 0

    override init(componentDescription: AudioComponentDescription, options: AudioComponentInstantiationOptions = []) throws {
        outBus = try AUAudioUnitBus(format: format)
        try super.init(componentDescription: componentDescription, options: options)
        busses = AUAudioUnitBusArray(audioUnit: self, busType: .output, busses: [outBus])
    }

    override var outputBusses: AUAudioUnitBusArray { busses }

    override var speechVoices: [AVSpeechSynthesisProviderVoice] {
        get {
            // Invisible sending turned off in the app: no voice to offer.
            if access(dataDir + "/voice-off", F_OK) == 0 { return [] }
            // The addon looks for a voice whose name starts with "ForeverAICompanion".
            let v = AVSpeechSynthesisProviderVoice(
                name: "ForeverAICompanion",
                identifier: "io.github.nullgatestudios.ForeverAICompanion.voice",
                primaryLanguages: ["en-US"],
                supportedLanguages: ["en-US", "en-GB", "es-ES", "es-MX", "es-US", "pt-BR", "fr-FR", "de-DE", "it-IT"])
            v.gender = .female
            return [v]
        }
        set {}
    }

    override func synthesizeSpeechRequest(_ speechRequest: AVSpeechSynthesisProviderRequest) {
        let text = plainText(fromSSML: speechRequest.ssmlRepresentation).trimmingCharacters(in: .whitespacesAndNewlines)
        // Someone else's text: not ours to keep, not even in the log.
        if isOurs(text) {
            log("message received: \(text.count) characters")
            deliver(text)
        }
        remaining = 441 // 20 ms of silence, then "done"
    }

    override func cancelSpeechRequest() {
        remaining = 0
    }

    override var internalRenderBlock: AUInternalRenderBlock {
        return { [unowned self] actionFlags, _, frameCount, _, outputData, _, _ in
            let buffers = UnsafeMutableAudioBufferListPointer(outputData)
            let n = min(Int(frameCount), max(self.remaining, 0))
            for i in 0..<buffers.count {
                if let p = buffers[i].mData { memset(p, 0, Int(buffers[i].mDataByteSize)) }
                buffers[i].mDataByteSize = UInt32(n * MemoryLayout<Float32>.size)
            }
            self.remaining -= n
            if self.remaining <= 0 {
                actionFlags.pointee = .offlineUnitRenderAction_Complete
            }
            return noErr
        }
    }
}
