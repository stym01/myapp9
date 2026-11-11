import AVFoundation
import Foundation

final class AudioCapture {

    static let shared = AudioCapture()

    private var audioEngine: AVAudioEngine?
    private var isRecording = false
    private var audioBuffer: [Float] = []
    private let targetSampleRate: Double = 16000
    private let lock = NSLock()

    var onTranscriptLine: ((String) -> Void)?

    private init() {}

    // MARK: - Microphone capture

    func startMicCapture() {
        guard !isRecording else { return }

        audioEngine = AVAudioEngine()
        guard let engine = audioEngine else { return }

        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)

        audioBuffer.removeAll()

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            self?.processAudioBuffer(buffer, sampleRate: format.sampleRate)
        }

        do {
            try engine.start()
            isRecording = true
            NSLog("[AudioCapture] mic recording started (rate=%.0f)", format.sampleRate)
        } catch {
            NSLog("[AudioCapture] failed to start: %@", error.localizedDescription)
        }
    }

    func stopMicCapture() {
        guard isRecording else { return }
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
        isRecording = false
        NSLog("[AudioCapture] mic recording stopped")
    }

    // MARK: - Get recorded audio as WAV data for transcription

    func getRecordedWAVData() -> Data? {
        lock.lock()
        let samples = audioBuffer
        lock.unlock()

        guard !samples.isEmpty else { return nil }

        let sampleRate: UInt32 = UInt32(targetSampleRate)
        let channels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
        let blockAlign = channels * (bitsPerSample / 8)

        var pcmData = Data()
        for sample in samples {
            let clamped = max(-1.0, min(1.0, sample))
            var int16 = Int16(clamped * 32767.0)
            pcmData.append(Data(bytes: &int16, count: 2))
        }

        var wav = Data()
        wav.append("RIFF".data(using: .ascii)!)
        var chunkSize = UInt32(36 + pcmData.count)
        wav.append(Data(bytes: &chunkSize, count: 4))
        wav.append("WAVE".data(using: .ascii)!)
        wav.append("fmt ".data(using: .ascii)!)
        var subchunk1Size: UInt32 = 16
        wav.append(Data(bytes: &subchunk1Size, count: 4))
        var audioFormat: UInt16 = 1 // PCM
        wav.append(Data(bytes: &audioFormat, count: 2))
        var numChannels = channels
        wav.append(Data(bytes: &numChannels, count: 2))
        var rate = sampleRate
        wav.append(Data(bytes: &rate, count: 4))
        var br = byteRate
        wav.append(Data(bytes: &br, count: 4))
        var ba = blockAlign
        wav.append(Data(bytes: &ba, count: 2))
        var bps = bitsPerSample
        wav.append(Data(bytes: &bps, count: 2))
        wav.append("data".data(using: .ascii)!)
        var dataSize = UInt32(pcmData.count)
        wav.append(Data(bytes: &dataSize, count: 4))
        wav.append(pcmData)

        return wav
    }

    func clearBuffer() {
        lock.lock()
        audioBuffer.removeAll()
        lock.unlock()
    }

    // MARK: - Transcription via Solvro API

    func transcribeRecording(completion: @escaping (String?) -> Void) {
        guard let wavData = getRecordedWAVData() else {
            completion(nil)
            return
        }

        guard let url = URL(string: "https://solvro.in/api/ai/transcribe") else {
            completion(nil)
            return
        }

        let boundary = UUID().uuidString
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue(SessionManager.shared.cookieHeader, forHTTPHeaderField: "Cookie")
        request.setValue("macos", forHTTPHeaderField: "x-solvro-platform")
        request.setValue(SessionManager.shared.timezoneHeader, forHTTPHeaderField: "x-timezone")

        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"audio\"; filename=\"recording.wav\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
        body.append(wavData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body

        URLSession.shared.dataTask(with: request) { data, response, _ in
            guard let data,
                  let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            do {
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let text = json["text"] as? String {
                    DispatchQueue.main.async { completion(text) }
                } else {
                    DispatchQueue.main.async { completion(nil) }
                }
            } catch {
                DispatchQueue.main.async { completion(nil) }
            }
        }.resume()
    }

    // MARK: - Audio processing

    private func processAudioBuffer(_ buffer: AVAudioPCMBuffer, sampleRate: Double) {
        guard let floatData = buffer.floatChannelData else { return }

        let frameCount = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)

        var mono = [Float](repeating: 0, count: frameCount)
        for i in 0..<frameCount {
            var sum: Float = 0
            for ch in 0..<channelCount {
                sum += floatData[ch][i]
            }
            mono[i] = sum / Float(max(channelCount, 1))
        }

        let resampled: [Float]
        if abs(sampleRate - targetSampleRate) > 1.0 {
            resampled = resample(mono, fromRate: sampleRate, toRate: targetSampleRate)
        } else {
            resampled = mono
        }

        lock.lock()
        audioBuffer.append(contentsOf: resampled)
        lock.unlock()
    }

    private func resample(_ input: [Float], fromRate: Double, toRate: Double) -> [Float] {
        guard !input.isEmpty, fromRate > 0, toRate > 0 else { return [] }
        if abs(fromRate - toRate) < 1.0 { return input }

        let ratio = fromRate / toRate
        let outSize = max(1, Int(floor(Double(input.count) * (toRate / fromRate))))
        var output = [Float](repeating: 0, count: outSize)

        for i in 0..<outSize {
            let srcPos = Double(i) * ratio
            let idx = Int(srcPos)
            let frac = Float(srcPos - Double(idx))
            if idx + 1 < input.count {
                output[i] = (1.0 - frac) * input[idx] + frac * input[idx + 1]
            } else {
                output[i] = input.last ?? 0
            }
        }
        return output
    }
}
