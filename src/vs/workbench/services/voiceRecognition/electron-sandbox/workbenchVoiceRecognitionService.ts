/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { CancellationToken } from 'vs/base/common/cancellation';
import { InstantiationType, registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { Emitter, Event } from 'vs/base/common/event';
import { IProgressService, ProgressLocation } from 'vs/platform/progress/common/progress';
import { DeferredPromise } from 'vs/base/common/async';
import { FileAccess } from 'vs/base/common/network';
import { ISharedProcessService } from 'vs/platform/ipc/electron-sandbox/services';

export const IWorkbenchVoiceRecognitionService = createDecorator<IWorkbenchVoiceRecognitionService>('workbenchVoiceRecognitionService');

export interface IWorkbenchVoiceRecognitionService {

	readonly _serviceBrand: undefined;

	/**
	 * Starts listening to the microphone transcribing the voice to text.
	 *
	 * @param cancellation a cancellation token to stop transcribing and
	 * listening to the microphone.
	 */
	transcribe(cancellation: CancellationToken): Event<string>;
}

class VoiceTranscriptionWorkletNode extends AudioWorkletNode {

	constructor(
		context: BaseAudioContext,
		options: AudioWorkletNodeOptions,
		private readonly onDidTranscribe: Emitter<string>,
		private readonly sharedProcessService: ISharedProcessService
	) {
		super(context, 'voice-transcription-worklet', options);

		this.registerListeners();
	}

	private registerListeners(): void {
		this.port.onmessage = e => {
			if (typeof e.data === 'string') {
				this.onDidTranscribe.fire(e.data);
			}
		};
	}

	async start(token: CancellationToken): Promise<void> {
		const sharedProcessConnection = await this.sharedProcessService.createRawConnection();

		token.onCancellationRequested(() => {
			this.port.postMessage('vscode:stopVoiceTranscription');
			this.disconnect();
		});

		this.port.postMessage('vscode:startVoiceTranscription', [sharedProcessConnection]);
	}
}

// TODO@voice
// - how to prevent data processing accumulation when processing is slow?
// - how to make this a singleton service that enables ref-counting on multiple callers?
// - voice module should directly transcribe the PCM32 data without wav+file conversion

export class WorkbenchVoiceRecognitionService implements IWorkbenchVoiceRecognitionService {

	declare readonly _serviceBrand: undefined;

	private static readonly AUDIO_SAMPLE_RATE = 16000;
	private static readonly AUDIO_SAMPLE_SIZE = 16;
	private static readonly AUDIO_CHANNELS = 1;

	constructor(
		@IProgressService private readonly progressService: IProgressService,
		@ISharedProcessService private readonly sharedProcessService: ISharedProcessService
	) { }

	transcribe(cancellation: CancellationToken): Event<string> {
		const onDidTranscribe = new Emitter<string>();
		cancellation.onCancellationRequested(() => onDidTranscribe.dispose());

		this.doTranscribe(onDidTranscribe, cancellation);

		return onDidTranscribe.event;
	}

	private doTranscribe(onDidTranscribe: Emitter<string>, token: CancellationToken): void {
		this.progressService.withProgress({
			location: ProgressLocation.Window,
			title: localize('voiceTranscription', "Voice Transcription"),
		}, async progress => {
			const recordingDone = new DeferredPromise<void>();

			progress.report({ message: localize('voiceTranscriptionGettingReady', "Getting microphone ready...") });

			const microphoneDevice = await navigator.mediaDevices.getUserMedia({
				audio: {
					sampleRate: WorkbenchVoiceRecognitionService.AUDIO_SAMPLE_RATE,
					sampleSize: WorkbenchVoiceRecognitionService.AUDIO_SAMPLE_SIZE,
					channelCount: WorkbenchVoiceRecognitionService.AUDIO_CHANNELS,
					autoGainControl: true,
					noiseSuppression: true
				}
			});

			if (token.isCancellationRequested) {
				return;
			}

			const audioContext = new AudioContext({
				sampleRate: WorkbenchVoiceRecognitionService.AUDIO_SAMPLE_RATE,
				latencyHint: 'interactive'
			});

			const microphoneSource = audioContext.createMediaStreamSource(microphoneDevice);

			token.onCancellationRequested(() => {
				for (const track of microphoneDevice.getTracks()) {
					track.stop();
				}

				microphoneSource.disconnect();
				audioContext.close();
				recordingDone.complete();
			});

			await audioContext.audioWorklet.addModule(FileAccess.asBrowserUri('vs/workbench/services/voiceRecognition/electron-sandbox/voiceTranscriptionWorklet.js').toString(true));

			if (token.isCancellationRequested) {
				return;
			}

			const voiceTranscriptionTarget = new VoiceTranscriptionWorkletNode(audioContext, {
				channelCount: WorkbenchVoiceRecognitionService.AUDIO_CHANNELS,
				channelCountMode: 'explicit'
			}, onDidTranscribe, this.sharedProcessService);
			await voiceTranscriptionTarget.start(token);

			if (token.isCancellationRequested) {
				return;
			}

			microphoneSource.connect(voiceTranscriptionTarget);

			progress.report({ message: localize('voiceTranscriptionRecording', "Recording from microphone...") });

			return recordingDone.p;
		});
	}
}

// Register Service
registerSingleton(IWorkbenchVoiceRecognitionService, WorkbenchVoiceRecognitionService, InstantiationType.Delayed);
