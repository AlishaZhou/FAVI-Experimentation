"use strict";

const video = document.querySelector("#camera");
const app = document.querySelector("#app");
const cameraButton = document.querySelector("#camera-toggle");
const cameraInputSelect = document.querySelector("#camera-input");
const flipCounterDisplay = document.querySelector("#flip-counter");
const statusText = document.querySelector("#status");
const audioMode = document.documentElement.dataset.audioMode || "indexed";
const configuredAudioFile = document.documentElement.dataset.audioFile;

const audioFiles = configuredAudioFile
    ? [configuredAudioFile]
    : Array.from({ length: 10 }, (_, index) =>
        `WFDE-Chapter-1/WFDE_chapter1_${index + 1}.mp3`
    );
const maxFlipCount = Number(document.documentElement.dataset.counterMax) || audioFiles.length;
const audioRangeStart = Number(document.documentElement.dataset.audioRangeStart) || 1;
const audioRangeEnd = Number(document.documentElement.dataset.audioRangeEnd) || 9;

const sampleWidth = 320;
const sampleHeight = 180;
const blockSize = 12;
const blockStep = 16;
const maxDisplacement = 8;
const zoneCount = 8;
const cameraCanvas = document.createElement("canvas");
cameraCanvas.width = sampleWidth;
cameraCanvas.height = sampleHeight;
const cameraContext = cameraCanvas.getContext("2d", { willReadFrequently: true });

let cameraStream;
let cameraDeviceId;
let cameraDevices = [];
let animationFrame;
let previousFrame;
let lastAnalyzedAt = 0;
let rightToLeftSweep;
let leftToRightSweep;
let flipCounter = 0;
const activeAudios = new Map();

function setStatus(message, state) {
    statusText.textContent = message;
    statusText.dataset.state = state;
}

function stopCamera() {
    if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = undefined;
    }

    if (cameraStream) {
        cameraStream.getTracks().forEach((track) => track.stop());
        cameraStream = undefined;
    }
    cameraDeviceId = undefined;
    cameraDevices = [];
    video.srcObject = null;
    app.classList.remove("is-live");
    previousFrame = undefined;
    rightToLeftSweep = undefined;
    leftToRightSweep = undefined;
    cameraButton.setAttribute("aria-label", "Start camera");
    cameraButton.setAttribute("aria-pressed", "false");
    if (cameraInputSelect) {
        cameraInputSelect.hidden = true;
        cameraInputSelect.disabled = true;
    }
    setStatus("Camera is off", "idle");
}

async function startCamera(deviceId) {
    if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("Camera access is not available in this browser.", "error");
        return;
    }

    const previousStream = cameraStream;
    let nextStream;
    if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = undefined;
    }
    cameraButton.disabled = true;
    if (cameraInputSelect) {
        cameraInputSelect.disabled = true;
    }
    setStatus(previousStream ? "Switching camera input…" : "Waiting for camera permission…", "idle");

    try {
        nextStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: deviceId ? { deviceId: { exact: deviceId } } : true
        });
        video.srcObject = nextStream;
        await video.play();
        cameraStream = nextStream;
        const videoTrack = nextStream.getVideoTracks()[0];
        cameraDeviceId = videoTrack?.getSettings?.().deviceId || deviceId;
        if (previousStream) {
            previousStream.getTracks().forEach((track) => track.stop());
        }
        app.classList.add("is-live");
        cameraButton.setAttribute("aria-label", "Stop camera");
        cameraButton.setAttribute("aria-pressed", "true");
        previousFrame = undefined;
        rightToLeftSweep = undefined;
        leftToRightSweep = undefined;
        setStatus("Ready — turn a page right to left", "ready");
        try {
            await refreshCameraDevices();
        } catch {
            if (cameraInputSelect) {
                cameraInputSelect.hidden = true;
                cameraInputSelect.disabled = true;
            }
            setStatus("Camera started, but available inputs could not be listed.", "error");
        }
        animationFrame = requestAnimationFrame(detectPageTurn);
    } catch (error) {
        if (nextStream) {
            nextStream.getTracks().forEach((track) => track.stop());
        }

        cameraStream = previousStream;
        video.srcObject = previousStream || null;
        if (previousStream) {
            try {
                await refreshCameraDevices();
            } catch {
                if (cameraInputSelect) {
                    cameraInputSelect.hidden = true;
                    cameraInputSelect.disabled = true;
                }
            }
            animationFrame = requestAnimationFrame(detectPageTurn);
            setStatus("Could not switch camera; the previous input remains active.", "error");
        } else if (error.name === "NotAllowedError" || error.name === "SecurityError") {
            app.classList.remove("is-live");
            setStatus("Allow camera access in your browser to begin.", "error");
        } else if (error.name === "NotFoundError") {
            app.classList.remove("is-live");
            setStatus("No camera was found on this device.", "error");
        } else {
            app.classList.remove("is-live");
            setStatus("The camera could not be started. Please try again.", "error");
        }
    } finally {
        cameraButton.disabled = false;
        if (cameraInputSelect) {
            cameraInputSelect.disabled = cameraInputSelect.hidden || !cameraStream;
        }
    }
}

async function refreshCameraDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) {
        cameraDevices = [];
        if (cameraInputSelect) {
            cameraInputSelect.hidden = true;
            cameraInputSelect.disabled = true;
        }
        return cameraDevices;
    }

    cameraDevices = (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === "videoinput" && device.deviceId);
    const activeDeviceId = cameraStream?.getVideoTracks()[0]?.getSettings?.().deviceId;
    if (activeDeviceId) {
        cameraDeviceId = activeDeviceId;
    }
    if (cameraInputSelect) {
        cameraInputSelect.replaceChildren();
        cameraDevices.forEach((device, index) => {
            const option = document.createElement("option");
            option.value = device.deviceId;
            option.textContent = device.label || `Camera ${index + 1}`;
            cameraInputSelect.append(option);
        });
        cameraInputSelect.hidden = cameraDevices.length < 2;
        cameraInputSelect.disabled = cameraDevices.length < 2;
        cameraInputSelect.value = cameraDeviceId && cameraDevices.some((device) => device.deviceId === cameraDeviceId)
            ? cameraDeviceId
            : cameraDevices[0]?.deviceId || "";
    }
    return cameraDevices;
}

function estimateHorizontalMotion(previous, current) {
    const leftMovingByZone = Array(zoneCount).fill(0);
    const rightMovingByZone = Array(zoneCount).fill(0);

    for (let y = blockStep; y < sampleHeight - blockSize - blockStep; y += blockStep) {
        for (let x = maxDisplacement + blockStep; x < sampleWidth - blockSize - maxDisplacement; x += blockStep) {
            let mean = 0;
            for (let row = 0; row < blockSize; row += 1) {
                for (let column = 0; column < blockSize; column += 1) {
                    mean += current[(y + row) * sampleWidth + x + column];
                }
            }
            mean /= blockSize * blockSize;

            let variance = 0;
            for (let row = 0; row < blockSize; row += 1) {
                for (let column = 0; column < blockSize; column += 1) {
                    const difference = current[(y + row) * sampleWidth + x + column] - mean;
                    variance += difference * difference;
                }
            }
            if (variance / (blockSize * blockSize) < 30) {
                continue;
            }

            let bestDisplacement = 0;
            let bestDifference = Infinity;
            let stillDifference = 0;

            for (let displacement = -maxDisplacement; displacement <= maxDisplacement; displacement += 1) {
                let difference = 0;
                for (let row = 0; row < blockSize; row += 1) {
                    for (let column = 0; column < blockSize; column += 1) {
                        const currentValue = current[(y + row) * sampleWidth + x + column];
                        const previousValue = previous[(y + row) * sampleWidth + x - displacement + column];
                        difference += Math.abs(currentValue - previousValue);
                    }
                }
                difference /= blockSize * blockSize;
                if (displacement === 0) {
                    stillDifference = difference;
                }
                if (difference < bestDifference) {
                    bestDifference = difference;
                    bestDisplacement = displacement;
                }
            }

            if (bestDifference < 32 && stillDifference - bestDifference > 5) {
                if (bestDisplacement <= -2) {
                    const zone = Math.floor(x / (sampleWidth / zoneCount));
                    leftMovingByZone[zone] += 1;
                } else if (bestDisplacement >= 2) {
                    const zone = Math.floor(x / (sampleWidth / zoneCount));
                    rightMovingByZone[zone] += 1;
                }
            }
        }
    }

    return { leftMovingByZone, rightMovingByZone };
}

function updateSweep(movingByZone, startZone, endZone, sweep, now) {
    const minimumBlocksPerZone = 2;
    const activeZones = movingByZone
        .map((count, zone) => count >= minimumBlocksPerZone ? zone : -1)
        .filter((zone) => zone >= 0);

    if (!sweep) {
        if (activeZones.includes(startZone)) {
            sweep = {
                startedAt: now,
                lastMotionAt: now,
                progress: startZone,
                progressFrames: 0,
                sawMiddle: false,
                edgeFrames: 0
            };
        }
        return { sweep, completed: false };
    }

    if (now - sweep.startedAt > 2800 || now - sweep.lastMotionAt > 450) {
        return { sweep: undefined, completed: false };
    }

    if (activeZones.length === 0) {
        return { sweep, completed: false };
    }

    sweep.lastMotionAt = now;
    const movingLeft = startZone > endZone;
    const progressZone = movingLeft ? activeZones[0] : activeZones[activeZones.length - 1];
    const middleStart = Math.min(startZone, endZone) + 1;
    const middleEnd = Math.max(startZone, endZone) - 1;
    if (activeZones.some((zone) => zone >= middleStart && zone <= middleEnd)) {
        sweep.sawMiddle = true;
    }

    if ((movingLeft && progressZone < sweep.progress) ||
        (!movingLeft && progressZone > sweep.progress)) {
        sweep.progress = progressZone;
        sweep.progressFrames += 1;
    }

    sweep.edgeFrames = progressZone === endZone ? sweep.edgeFrames + 1 : 0;
    if (progressZone === endZone && sweep.sawMiddle &&
        (sweep.progressFrames >= 2 || sweep.edgeFrames >= 2)) {
        return { sweep: undefined, completed: true };
    }

    return { sweep, completed: false };
}

function detectPageTurn() {
    if (!cameraStream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        animationFrame = requestAnimationFrame(detectPageTurn);
        return;
    }

    const now = performance.now();
    if (now - lastAnalyzedAt < 60) {
        animationFrame = requestAnimationFrame(detectPageTurn);
        return;
    }
    lastAnalyzedAt = now;

    cameraContext.drawImage(video, 0, 0, sampleWidth, sampleHeight);
    const rgba = cameraContext.getImageData(0, 0, sampleWidth, sampleHeight).data;
    const currentFrame = new Uint8Array(sampleWidth * sampleHeight);
    for (let source = 0, target = 0; source < rgba.length; source += 4, target += 1) {
        currentFrame[target] = (rgba[source] * 30 + rgba[source + 1] * 59 + rgba[source + 2] * 11) / 100;
    }

    if (previousFrame) {
        const { leftMovingByZone, rightMovingByZone } = estimateHorizontalMotion(previousFrame, currentFrame);
        const rightToLeft = updateSweep(leftMovingByZone, zoneCount - 1, 0, rightToLeftSweep, now);
        rightToLeftSweep = rightToLeft.sweep;
        if (rightToLeft.completed) {
            handleReversePageTurn();
        }
        const leftToRight = updateSweep(rightMovingByZone, 0, zoneCount - 1, leftToRightSweep, now);
        leftToRightSweep = leftToRight.sweep;
        if (leftToRight.completed) {
            handlePageTurn();
        }
    }

    previousFrame = currentFrame;
    animationFrame = requestAnimationFrame(detectPageTurn);
}

function handlePageTurn() {
    if (flipCounter >= maxFlipCount) {
        return;
    }

    flipCounter += 1;
    updateFlipCounter();
    if (audioMode === "range") {
        syncRangeAudio();
    } else if (flipCounter === maxFlipCount) {
        stopAllAudios();
    } else {
        playAudioForCounter();
    }
}

function handleReversePageTurn() {
    if (flipCounter <= 0) {
        return;
    }

    flipCounter -= 1;
    updateFlipCounter();

    if (audioMode === "range") {
        syncRangeAudio();
        return;
    }

    for (const [trackNumber, audio] of activeAudios) {
        if (trackNumber > flipCounter) {
            audio.pause();
            audio.currentTime = 0;
            activeAudios.delete(trackNumber);
        }
    }

    if (flipCounter > 0) {
        const selectedAudio = activeAudios.get(flipCounter);
        if (!selectedAudio || selectedAudio.paused || selectedAudio.ended) {
            playAudioForCounter();
        }
    }
}

function updateFlipCounter() {
    flipCounterDisplay.value = `${flipCounter} / ${maxFlipCount}`;
    flipCounterDisplay.setAttribute("aria-label", `Page ${flipCounter} of ${maxFlipCount}`);
}

function playAudioForCounter() {
    const trackNumber = flipCounter;
    playAudioFile(audioFiles[trackNumber - 1], trackNumber, `track ${trackNumber}`);
}

function syncRangeAudio() {
    if (flipCounter < audioRangeStart || flipCounter > audioRangeEnd) {
        stopAllAudios();
        return;
    }

    const selectedAudio = activeAudios.get(1);
    if (!selectedAudio || selectedAudio.paused || selectedAudio.ended) {
        playAudioFile(audioFiles[0], 1, "Chapter 3");
    }
}

function playAudioFile(source, trackNumber, label) {
    const audio = new Audio(source);
    audio.currentTime = 0;
    activeAudios.set(trackNumber, audio);
    setStatus(`Playing ${label}`, "playing");

    audio.addEventListener("ended", () => {
        if (activeAudios.get(trackNumber) === audio) {
            activeAudios.delete(trackNumber);
        }
    }, { once: true });

    audio.addEventListener("error", () => {
        if (activeAudios.get(trackNumber) === audio) {
            activeAudios.delete(trackNumber);
        }
        setStatus("Audio could not be loaded. Check the chapter audio files.", "error");
    }, { once: true });

    audio.play().catch(() => {
        if (activeAudios.get(trackNumber) !== audio) {
            return;
        }
        activeAudios.delete(trackNumber);
        setStatus("Tap Start camera again, then allow audio playback.", "error");
    });
}

function stopAllAudios() {
    for (const audio of activeAudios.values()) {
        audio.pause();
        audio.currentTime = 0;
    }
    activeAudios.clear();
    setStatus("All audio stopped.", "ready");
}

cameraButton.addEventListener("click", () => {
    if (cameraStream) {
        stopCamera();
    } else {
        startCamera();
    }
});

cameraInputSelect?.addEventListener("change", () => {
    if (cameraInputSelect.value && cameraInputSelect.value !== cameraDeviceId) {
        startCamera(cameraInputSelect.value);
    }
});

navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    if (!cameraStream) {
        return;
    }

    refreshCameraDevices().catch(() => {
        if (cameraInputSelect) {
            cameraInputSelect.hidden = true;
            cameraInputSelect.disabled = true;
        }
        setStatus("Camera inputs could not be refreshed.", "error");
    });
});