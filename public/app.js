const CHUNK_SIZE = 256 * 1024;
const BACKPRESSURE_THRESHOLD = 4 * 1024 * 1024;
const LARGE_FILE_THRESHOLD = 512 * 1024 * 1024;
const CONTROL_TIMEOUT_MS = 5 * 60 * 1000;

const state = {
  role: "sender",
  code: "",
  deviceName: "",
  ws: null,
  wsPromise: null,
  pc: null,
  rtcConfig: { iceServers: [] },
  dataChannel: null,
  selectedFiles: [],
  sending: false,
  controlWaiters: [],
  pendingChunkMeta: null,
  incomingMeta: null,
  connected: false,
  peerDeviceName: "",
  networkMode: "lan-only",
  outgoingSession: null,
};

const joinForm = document.querySelector("#join-form");
const rolePicker = document.querySelector("#role-picker");
const pinInputs = Array.from(document.querySelectorAll(".pin-input"));
const deviceNameInput = document.querySelector("#device-name");
const joinButton = document.querySelector("#join-button");
const rejoinButton = document.querySelector("#rejoin-button");
const statusText = document.querySelector("#status-text");
const peerText = document.querySelector("#peer-text");
const senderPanel = document.querySelector("#sender-panel");
const receiverPanel = document.querySelector("#receiver-panel");
const transferPanel = document.querySelector("#transfer-panel");
const fileInput = document.querySelector("#file-input");
const fileMeta = document.querySelector("#file-meta");
const dropzone = document.querySelector("#dropzone");
const sendButton = document.querySelector("#send-button");
const saveButton = document.querySelector("#save-button");
const progressLabel = document.querySelector("#progress-label");
const progressValue = document.querySelector("#progress-value");
const progressBar = document.querySelector("#progress-bar");
const transferMeta = document.querySelector("#transfer-meta");

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.style.color = isError ? "var(--danger)" : "var(--ink)";
}

function setPeerText(message = "") {
  peerText.textContent = message;
  peerText.classList.toggle("hidden", !message);
}

function unlockJoin() {
  joinButton.disabled = false;
}

function updateRole(role) {
  state.role = role;
  rolePicker.querySelectorAll(".role-card").forEach((button) => {
    button.classList.toggle("active", button.dataset.role === role);
  });
  senderPanel.classList.toggle("hidden", role !== "sender");
  receiverPanel.classList.toggle("hidden", role !== "receiver");
}

function readCode() {
  return pinInputs.map((input) => input.value).join("");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function resetTransferProgress() {
  transferPanel.classList.add("hidden");
  progressLabel.textContent = "等待传输";
  progressValue.textContent = "0%";
  progressBar.style.width = "0%";
  transferMeta.textContent = "尚未开始";
}

function setProgress(label, done, total, meta) {
  transferPanel.classList.remove("hidden");
  progressLabel.textContent = label;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  progressValue.textContent = `${percent}%`;
  progressBar.style.width = `${percent}%`;
  transferMeta.textContent = meta;
}

function getDefaultDeviceName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "device";
  return `${platform}`.replace(/\s+/g, "-").slice(0, 32);
}

function persistDraft() {
  localStorage.setItem(
    "flash-transfer-draft",
    JSON.stringify({
      role: state.role,
      code: state.code || readCode(),
      deviceName: state.deviceName || deviceNameInput.value.trim(),
    }),
  );
}

function restoreDraft() {
  const raw = localStorage.getItem("flash-transfer-draft");
  if (!raw) return;
  try {
    const draft = JSON.parse(raw);
    if (draft.role) updateRole(draft.role);
    if (draft.deviceName) deviceNameInput.value = draft.deviceName;
    if (/^\d{4}$/.test(draft.code || "")) {
      draft.code.split("").forEach((char, index) => {
        if (pinInputs[index]) pinInputs[index].value = char;
      });
      state.code = draft.code;
    }
  } catch (error) {
    console.warn("Failed to restore draft", error);
  }
}

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function cleanupSocket() {
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.onmessage = null;
    state.ws.onerror = null;
    try {
      state.ws.close();
    } catch (error) {
      console.warn("Socket close failed", error);
    }
  }
  state.ws = null;
  state.wsPromise = null;
}

function markResumePending() {
  if (!state.outgoingSession) return;
  const hasPendingFiles = state.outgoingSession.files.some((file) => !file.completed);
  if (hasPendingFiles) {
    state.outgoingSession.resumePending = true;
  }
}

function cleanupPeerConnection() {
  if (state.dataChannel) {
    state.dataChannel.onmessage = null;
    state.dataChannel.onopen = null;
    state.dataChannel.onclose = null;
    state.dataChannel.onbufferedamountlow = null;
    try {
      state.dataChannel.close();
    } catch (error) {
      console.warn("Data channel close failed", error);
    }
    state.dataChannel = null;
  }

  if (state.pc) {
    state.pc.onicecandidate = null;
    state.pc.onconnectionstatechange = null;
    state.pc.ondatachannel = null;
    try {
      state.pc.close();
    } catch (error) {
      console.warn("Peer connection close failed", error);
    }
    state.pc = null;
  }

  state.connected = false;
  state.sending = false;
  state.pendingChunkMeta = null;
  state.controlWaiters.forEach((waiter) => {
    clearTimeout(waiter.timer);
    if (waiter.reject) {
      waiter.reject(new Error("连接已断开"));
    }
  });
  state.controlWaiters = [];
  sendButton.disabled = true;
}

function resetIncomingFileState(closeStream = false) {
  if (closeStream && state.incomingMeta?.writableStream) {
    state.incomingMeta.writableStream.close().catch(() => {});
  }
  state.incomingMeta = null;
  state.pendingChunkMeta = null;
  saveButton.disabled = true;
}

function refreshFileMeta() {
  if (state.selectedFiles.length === 0) {
    fileMeta.classList.add("hidden");
    fileMeta.textContent = "";
    sendButton.disabled = true;
    return;
  }

  const totalBytes = state.selectedFiles.reduce((sum, file) => sum + file.size, 0);
  const preview = state.selectedFiles
    .slice(0, 6)
    .map((file, index) => `${index + 1}. ${file.name} (${formatBytes(file.size)})`)
    .join("\n");
  const extra =
    state.selectedFiles.length > 6 ? `\n... 还有 ${state.selectedFiles.length - 6} 个文件` : "";

  fileMeta.textContent = `文件数: ${state.selectedFiles.length}
总大小: ${formatBytes(totalBytes)}
${preview}${extra}`;
  fileMeta.classList.remove("hidden");

  if (state.connected && !state.sending) {
    sendButton.disabled = false;
  }
}

function createOutgoingSession(files) {
  return {
    batchId: createId(),
    currentFileIndex: 0,
    resumePending: false,
    files: Array.from(files).map((file) => ({
      id: createId(),
      file,
      name: file.name,
      size: file.size,
      type: file.type,
      chunkSize: CHUNK_SIZE,
      totalChunks: Math.ceil(file.size / CHUNK_SIZE) || 1,
      completed: false,
    })),
  };
}

function getFileIdentity(file) {
  return [file.name, file.size, file.lastModified, file.type].join("::");
}

function updateSelectedFiles(files, mode = "append") {
  if (state.sending) {
    setStatus("传输进行中，暂时不能修改文件队列。", true);
    return;
  }

  const nextFiles = Array.from(files);
  if (mode === "replace") {
    state.selectedFiles = nextFiles;
  } else {
    const merged = [...state.selectedFiles];
    const known = new Set(merged.map(getFileIdentity));
    for (const file of nextFiles) {
      const identity = getFileIdentity(file);
      if (!known.has(identity)) {
        merged.push(file);
        known.add(identity);
      }
    }
    state.selectedFiles = merged;
  }

  state.outgoingSession = null;
  refreshFileMeta();
}

function ensureOutgoingSession() {
  if (!state.outgoingSession) {
    state.outgoingSession = createOutgoingSession(state.selectedFiles);
  }
  return state.outgoingSession;
}

function getMissingChunkIndexes(meta) {
  const missing = [];
  for (let index = 0; index < meta.totalChunks; index += 1) {
    if (!meta.receivedChunks.has(index)) {
      missing.push(index);
    }
  }
  return missing;
}

function advanceContiguousChunk(meta) {
  while (meta.receivedChunks.has(meta.contiguousChunkIndex)) {
    meta.contiguousChunkIndex += 1;
  }
}

async function loadRtcConfig() {
  const response = await fetch("/config", { cache: "no-store" });
  const config = await response.json();
  state.rtcConfig = config.rtcConfig || { iceServers: [] };
  state.networkMode = config.networkMode || "lan-only";
  if (state.networkMode === "lan-only") {
    setStatus("当前为纯局域网离线模式。");
  }
}

async function ensureSocket() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return state.ws;
  if (state.wsPromise) return state.wsPromise;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  state.wsPromise = new Promise((resolve, reject) => {
    const ws = new WebSocket(`${protocol}//${window.location.host}`);
    state.ws = ws;

    ws.addEventListener("open", () => {
      state.wsPromise = null;
      resolve(ws);
    });

    ws.addEventListener(
      "error",
      () => {
        state.wsPromise = null;
        reject(new Error("WebSocket 连接失败"));
      },
      { once: true },
    );

    ws.addEventListener("message", async (event) => {
      const message = JSON.parse(event.data);
      await handleServerMessage(message);
    });

    ws.addEventListener("close", () => {
      markResumePending();
      cleanupPeerConnection();
      state.ws = null;
      state.wsPromise = null;
      unlockJoin();
      if (state.code) {
        setStatus("信令连接已断开，可点击快速重新配对。", true);
      }
    });
  });

  return state.wsPromise;
}

function sendSignal(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ type: "signal", payload }));
}

function sendControl(message) {
  if (!state.dataChannel || state.dataChannel.readyState !== "open") {
    throw new Error("数据通道未就绪");
  }
  state.dataChannel.send(JSON.stringify(message));
}

function waitForAnyControl(matchers, timeoutMs = CONTROL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const waiters = matchers.map((matcher) => {
      const waiter = {
        type: matcher.type,
        predicate: matcher.predicate || (() => true),
        timer: null,
        reject,
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
      };
      waiter.timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("等待控制消息超时"));
      }, timeoutMs);
      return waiter;
    });

    function cleanup() {
      waiters.forEach((waiter) => clearTimeout(waiter.timer));
      state.controlWaiters = state.controlWaiters.filter((item) => !waiters.includes(item));
    }

    state.controlWaiters.push(...waiters);
  });
}

function resolveControlWaiters(message) {
  for (const waiter of [...state.controlWaiters]) {
    if (waiter.type === message.type && waiter.predicate(message)) {
      clearTimeout(waiter.timer);
      state.controlWaiters = state.controlWaiters.filter((item) => item !== waiter);
      waiter.resolve(message);
      return true;
    }
  }
  return false;
}

async function setupPeerConnection(initiator) {
  cleanupPeerConnection();

  const pc = new RTCPeerConnection(state.rtcConfig);
  state.pc = pc;

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({ kind: "candidate", candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    const next = pc.connectionState;
    if (next === "connected") {
      state.connected = true;
      if (state.role === "sender" && state.selectedFiles.length > 0 && !state.sending) {
        sendButton.disabled = false;
      }
      if (state.incomingMeta && !state.incomingMeta.completed) {
        setStatus(`连接恢复，等待继续接收 ${state.incomingMeta.name}。`);
      } else {
        setStatus("连接成功，可以开始传输。");
      }
    } else if (["failed", "disconnected", "closed"].includes(next)) {
      markResumePending();
      state.connected = false;
      state.sending = false;
      sendButton.disabled = true;
      setStatus("点对点连接已断开，可点击快速重新配对。", true);
    }
  };

  pc.ondatachannel = (event) => {
    bindDataChannel(event.channel);
  };

  if (initiator) {
    const channel = pc.createDataChannel("file-transfer", { ordered: true });
    bindDataChannel(channel);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ kind: "description", description: pc.localDescription });
  }
}

function bindDataChannel(channel) {
  state.dataChannel = channel;
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = BACKPRESSURE_THRESHOLD / 2;

  channel.onopen = () => {
    state.connected = true;
    if (state.role === "sender" && state.selectedFiles.length > 0 && !state.sending) {
      sendButton.disabled = false;
    }

    if (state.outgoingSession?.resumePending) {
      setStatus("连接恢复，正在继续传输。");
      state.outgoingSession.resumePending = false;
      sendFileQueue().catch((error) => {
        setStatus(error.message || "继续传输失败。", true);
      });
      return;
    }

    if (state.incomingMeta && !state.incomingMeta.completed) {
      setStatus(`连接恢复，等待继续接收 ${state.incomingMeta.name}。`);
      return;
    }

    setStatus("数据通道已建立。");
  };

  channel.onclose = () => {
    markResumePending();
    state.connected = false;
    state.sending = false;
    sendButton.disabled = true;
    setStatus("数据通道已关闭，可点击快速重新配对。", true);
  };

  channel.onmessage = async (event) => {
    if (typeof event.data === "string") {
      const message = JSON.parse(event.data);
      if (!resolveControlWaiters(message)) {
        await handleDataMessage(message);
      }
      return;
    }
    await handleBinaryChunk(event.data);
  };
}

async function handleServerMessage(message) {
  switch (message.type) {
    case "ready":
      setStatus(message.message);
      return;
    case "joined":
      setStatus(message.message);
      setPeerText("");
      return;
    case "paired":
      state.peerDeviceName = message.peerDeviceName || "";
      setPeerText(`已连接对端：${message.peerDeviceName || message.peerRole}`);
      setStatus("配对成功，正在建立点对点连接。");
      await setupPeerConnection(message.initiator);
      return;
    case "signal":
      await handleSignalMessage(message.payload);
      return;
    case "room_full":
    case "role_conflict":
    case "room_timeout":
    case "error":
      unlockJoin();
      setStatus(message.message, true);
      return;
    case "peer_left":
      unlockJoin();
      setPeerText("");
      setStatus(message.message, true);
      markResumePending();
      cleanupPeerConnection();
      return;
    default:
      return;
  }
}

async function handleSignalMessage(payload) {
  if (!state.pc) {
    await setupPeerConnection(false);
  }

  if (payload.kind === "description") {
    await state.pc.setRemoteDescription(payload.description);
    if (payload.description.type === "offer") {
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      sendSignal({ kind: "description", description: state.pc.localDescription });
    }
    return;
  }

  if (payload.kind === "candidate" && payload.candidate) {
    try {
      await state.pc.addIceCandidate(payload.candidate);
    } catch (error) {
      console.error("ICE candidate error", error);
    }
  }
}

function createIncomingMeta(message) {
  return {
    id: message.file.id,
    batchId: message.batchId,
    name: message.file.name,
    size: message.file.size,
    type: message.file.type,
    index: message.index,
    total: message.total,
    chunkSize: message.file.chunkSize || CHUNK_SIZE,
    totalChunks: message.file.totalChunks || Math.ceil(message.file.size / CHUNK_SIZE) || 1,
    receivedChunks: new Set(),
    contiguousChunkIndex: 0,
    receivedBytes: 0,
    chunks: [],
    writableStream: null,
    selectedFileHandle: null,
    awaitingCompletion: false,
    completed: false,
    pendingSaveSelection: false,
  };
}

function reuseIncomingMeta(message) {
  return (
    state.incomingMeta &&
    state.incomingMeta.id === message.file.id &&
    !state.incomingMeta.completed
  );
}

async function handleDataMessage(message) {
  if (message.type === "file_offer") {
    const isResume = reuseIncomingMeta(message);
    if (!isResume) {
      resetIncomingFileState();
      state.incomingMeta = createIncomingMeta(message);
    }

    const meta = state.incomingMeta;
    meta.index = message.index;
    meta.total = message.total;
    meta.size = message.file.size;
    meta.type = message.file.type;
    meta.name = message.file.name;
    meta.chunkSize = message.file.chunkSize || CHUNK_SIZE;
    meta.totalChunks = message.file.totalChunks || meta.totalChunks;

    setProgress(
      `等待接收 ${meta.name}`,
      meta.receivedBytes,
      meta.size,
      `${message.index + 1}/${message.total} 个文件，已收到 ${formatBytes(meta.receivedBytes)}`,
    );

    if (isResume && (meta.writableStream || meta.receivedBytes > 0)) {
      setStatus(`继续接收 ${meta.name}，从第 ${meta.contiguousChunkIndex + 1} 块恢复。`);
      sendControl({
        type: "file_ready",
        fileId: meta.id,
        nextChunkIndex: meta.contiguousChunkIndex,
      });
      return;
    }

    if ("showSaveFilePicker" in window) {
      meta.pendingSaveSelection = true;
      saveButton.disabled = false;
      setStatus(`请点击按钮，为 ${meta.name} 选择保存位置。`);
      return;
    }

    if (meta.size > LARGE_FILE_THRESHOLD) {
      sendControl({
        type: "transfer_error",
        fileId: meta.id,
        message: "当前浏览器不支持流式保存，无法接收超大文件。",
      });
      setStatus("当前浏览器不支持流式保存，已拒绝超大文件。", true);
      resetIncomingFileState();
      return;
    }

    sendControl({
      type: "file_ready",
      fileId: meta.id,
      nextChunkIndex: meta.contiguousChunkIndex,
    });
    return;
  }

  if (message.type === "chunk_meta") {
    state.pendingChunkMeta = message;
    return;
  }

  if (message.type === "file_complete") {
    await handleFileComplete(message);
    return;
  }

  if (message.type === "batch_complete") {
    setStatus("文件队列接收完成。");
    return;
  }

  if (message.type === "transfer_error") {
    setStatus(message.message || "传输失败。", true);
    state.sending = false;
    sendButton.disabled = !state.connected || state.selectedFiles.length === 0;
    return;
  }
}

async function writeIncomingChunk(meta, chunkIndex, buffer) {
  const byteOffset = chunkIndex * meta.chunkSize;
  if (meta.writableStream) {
    await meta.writableStream.seek(byteOffset);
    await meta.writableStream.write(buffer);
    return;
  }

  meta.chunks[chunkIndex] = buffer;
}

async function handleBinaryChunk(buffer) {
  const meta = state.incomingMeta;
  const chunkMeta = state.pendingChunkMeta;
  state.pendingChunkMeta = null;

  if (!meta || !chunkMeta || chunkMeta.fileId !== meta.id) {
    return;
  }

  const { chunkIndex } = chunkMeta;
  if (!meta.receivedChunks.has(chunkIndex)) {
    await writeIncomingChunk(meta, chunkIndex, buffer);
    meta.receivedChunks.add(chunkIndex);
    meta.receivedBytes += buffer.byteLength;
    advanceContiguousChunk(meta);
  }

  setProgress(
    `接收 ${meta.name}`,
    meta.receivedBytes,
    meta.size,
    `${formatBytes(meta.receivedBytes)} / ${formatBytes(meta.size)}，已完成 ${meta.receivedChunks.size}/${meta.totalChunks} 块`,
  );

  if (meta.awaitingCompletion && meta.receivedChunks.size === meta.totalChunks) {
    await finalizeIncomingFile();
  }
}

async function handleFileComplete(message) {
  const meta = state.incomingMeta;
  if (!meta || meta.id !== message.fileId) return;

  meta.awaitingCompletion = true;
  const missingChunks = getMissingChunkIndexes(meta);
  if (missingChunks.length > 0) {
    setStatus(`${meta.name} 缺少 ${missingChunks.length} 个分片，正在请求补发。`, true);
    sendControl({
      type: "chunk_resend_request",
      fileId: meta.id,
      missingChunks,
    });
    return;
  }

  await finalizeIncomingFile();
}

async function finalizeIncomingFile() {
  const meta = state.incomingMeta;
  if (!meta || meta.completed) return;

  if (meta.writableStream) {
    await meta.writableStream.close();
  } else {
    const blob = new Blob(meta.chunks, {
      type: meta.type || "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = meta.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  meta.completed = true;
  setProgress(
    `已完成 ${meta.name}`,
    meta.size,
    meta.size,
    `${meta.index + 1}/${meta.total} 个文件已完成`,
  );
  setStatus(`${meta.name} 接收完成。`);

  sendControl({
    type: "file_received",
    fileId: meta.id,
  });

  resetIncomingFileState();
}

async function waitForBufferedAmountLow(channel) {
  await new Promise((resolve) => {
    channel.onbufferedamountlow = () => {
      channel.onbufferedamountlow = null;
      resolve();
    };
  });
}

async function sendChunk(channel, fileEntry, chunkIndex, index, totalFiles) {
  const start = chunkIndex * fileEntry.chunkSize;
  const chunk = fileEntry.file.slice(start, start + fileEntry.chunkSize);
  const buffer = await chunk.arrayBuffer();

  if (channel.bufferedAmount > BACKPRESSURE_THRESHOLD) {
    await waitForBufferedAmountLow(channel);
  }

  sendControl({
    type: "chunk_meta",
    fileId: fileEntry.id,
    chunkIndex,
    byteLength: buffer.byteLength,
  });
  channel.send(buffer);

  const sentBytes = Math.min(fileEntry.size, start + buffer.byteLength);
  setProgress(
    `发送 ${fileEntry.name}`,
    sentBytes,
    fileEntry.size,
    `${index + 1}/${totalFiles} 个文件，${formatBytes(sentBytes)} / ${formatBytes(fileEntry.size)}，第 ${chunkIndex + 1}/${fileEntry.totalChunks} 块`,
  );
}

async function sendChunkRange(channel, fileEntry, startChunkIndex, index, totalFiles) {
  for (let chunkIndex = startChunkIndex; chunkIndex < fileEntry.totalChunks; chunkIndex += 1) {
    await sendChunk(channel, fileEntry, chunkIndex, index, totalFiles);
  }
}

async function resendChunks(channel, fileEntry, missingChunks, index, totalFiles) {
  for (const chunkIndex of missingChunks) {
    await sendChunk(channel, fileEntry, chunkIndex, index, totalFiles);
  }
}

async function waitForFileConfirmation(fileEntry, index, totalFiles) {
  while (true) {
    const message = await waitForAnyControl([
      { type: "file_received", predicate: (payload) => payload.fileId === fileEntry.id },
      { type: "chunk_resend_request", predicate: (payload) => payload.fileId === fileEntry.id },
      { type: "transfer_error", predicate: (payload) => payload.fileId === fileEntry.id },
    ]);

    if (message.type === "file_received") {
      return;
    }

    if (message.type === "transfer_error") {
      throw new Error(message.message || `${fileEntry.name} 接收失败`);
    }

    await resendChunks(
      state.dataChannel,
      fileEntry,
      message.missingChunks || [],
      index,
      totalFiles,
    );
    sendControl({
      type: "file_complete",
      batchId: state.outgoingSession.batchId,
      fileId: fileEntry.id,
      index,
      total: totalFiles,
    });
  }
}

async function sendFileQueue() {
  if (
    !state.dataChannel ||
    state.dataChannel.readyState !== "open" ||
    state.selectedFiles.length === 0 ||
    state.sending
  ) {
    return;
  }

  const session = ensureOutgoingSession();
  const totalFiles = session.files.length;
  state.sending = true;
  sendButton.disabled = true;

  try {
    for (let index = session.currentFileIndex; index < totalFiles; index += 1) {
      const fileEntry = session.files[index];
      if (fileEntry.completed) continue;

      sendControl({
        type: "file_offer",
        batchId: session.batchId,
        index,
        total: totalFiles,
        file: {
          id: fileEntry.id,
          name: fileEntry.name,
          size: fileEntry.size,
          type: fileEntry.type,
          chunkSize: fileEntry.chunkSize,
          totalChunks: fileEntry.totalChunks,
        },
      });

      const readyMessage = await waitForAnyControl([
        { type: "file_ready", predicate: (message) => message.fileId === fileEntry.id },
        { type: "transfer_error", predicate: (message) => message.fileId === fileEntry.id },
      ]);

      if (readyMessage.type === "transfer_error") {
        throw new Error(readyMessage.message || `${fileEntry.name} 无法开始传输`);
      }

      const nextChunkIndex = Math.min(
        fileEntry.totalChunks,
        Number(readyMessage.nextChunkIndex || 0),
      );

      await sendChunkRange(state.dataChannel, fileEntry, nextChunkIndex, index, totalFiles);
      sendControl({
        type: "file_complete",
        batchId: session.batchId,
        fileId: fileEntry.id,
        index,
        total: totalFiles,
      });

      await waitForFileConfirmation(fileEntry, index, totalFiles);
      fileEntry.completed = true;
      session.currentFileIndex = index + 1;
    }

    sendControl({ type: "batch_complete", batchId: session.batchId, total: totalFiles });
    state.outgoingSession = null;
    setStatus("文件队列发送完成。");
  } catch (error) {
    session.resumePending = true;
    setStatus(error.message || "传输失败。", true);
    try {
      sendControl({
        type: "transfer_error",
        batchId: session.batchId,
        fileId: session.files[session.currentFileIndex]?.id || "",
        message: error.message || "传输失败。",
      });
    } catch (sendError) {
      console.warn("Failed to send transfer error", sendError);
    }
  } finally {
    state.sending = false;
    sendButton.disabled = !state.connected || state.selectedFiles.length === 0;
  }
}

async function joinRoom() {
  const code = readCode();
  const deviceName = deviceNameInput.value.trim() || getDefaultDeviceName();

  if (!/^\d{4}$/.test(code)) {
    setStatus("请输入完整的 4 位数字配对码。", true);
    return;
  }

  state.code = code;
  state.deviceName = deviceName;
  persistDraft();
  resetTransferProgress();
  setPeerText("");
  cleanupPeerConnection();

  try {
    const ws = await ensureSocket();
    ws.send(
      JSON.stringify({
        type: "join",
        code,
        role: state.role,
        deviceName,
      }),
    );
    joinButton.disabled = true;
  } catch (error) {
    unlockJoin();
    setStatus("无法连接信令服务。", true);
  }
}

async function quickRejoin() {
  cleanupPeerConnection();
  cleanupSocket();
  unlockJoin();
  if (!/^\d{4}$/.test(readCode())) {
    setStatus("请先输入有效的 4 位配对码。", true);
    return;
  }
  setStatus("正在重新配对...");
  await joinRoom();
}

rolePicker.addEventListener("click", (event) => {
  const button = event.target.closest(".role-card");
  if (!button) return;
  updateRole(button.dataset.role);
  persistDraft();
});

pinInputs.forEach((input, index) => {
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 1);
    if (input.value && index < pinInputs.length - 1) {
      pinInputs[index + 1].focus();
    }
    persistDraft();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Backspace" && !input.value && index > 0) {
      pinInputs[index - 1].focus();
    }
  });
});

deviceNameInput.addEventListener("input", persistDraft);

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await joinRoom();
});

rejoinButton.addEventListener("click", async () => {
  await quickRejoin();
});

fileInput.addEventListener("change", () => {
  updateSelectedFiles(fileInput.files, "append");
  fileInput.value = "";
});

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("dragging");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragging");
});

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
  if (event.dataTransfer?.files?.length) {
    updateSelectedFiles(event.dataTransfer.files, "append");
  }
});

sendButton.addEventListener("click", async () => {
  await sendFileQueue();
});

saveButton.addEventListener("click", async () => {
  const meta = state.incomingMeta;
  if (!meta) {
    setStatus("当前没有待保存的文件。", true);
    return;
  }

  if (!("showSaveFilePicker" in window)) {
    setStatus("当前浏览器不支持直接保存，将在接收完成后触发下载。");
    saveButton.disabled = true;
    return;
  }

  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: meta.name || "received-file",
    });
    meta.selectedFileHandle = handle;
    meta.writableStream = await handle.createWritable();
    meta.pendingSaveSelection = false;
    saveButton.disabled = true;
    setStatus(`保存位置已确认：${meta.name}`);
    sendControl({
      type: "file_ready",
      fileId: meta.id,
      nextChunkIndex: meta.contiguousChunkIndex,
    });
  } catch (error) {
    sendControl({
      type: "transfer_error",
      fileId: meta.id,
      message: "接收方取消了保存位置选择。",
    });
    setStatus("已取消当前文件接收。", true);
    resetIncomingFileState();
  }
});

deviceNameInput.value = getDefaultDeviceName();
updateRole("sender");
restoreDraft();
resetTransferProgress();
loadRtcConfig().catch(() => {
  setStatus("RTC 配置加载失败，将尝试仅局域网直连。", true);
});
