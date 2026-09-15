/**
 * AudioPlayer — 时间线预调度音频播放器（魔改自 pi-chamber 老版）
 *
 * 单例，页面级复用。AudioContext 惰性创建（需在用户手势栈内 ensure()）。
 *
 * 核心机制：
 *   不用 onended 链式调度（有延迟，产生爆音），而是维护一条时间线
 *   (nextStartTime)：每次 enqueue 用 source.start(nextStartTime) 把音频
 *   精确排上时间轴，由音频线程无缝衔接。
 *
 *   剩余可播时长 = nextStartTime - currentTime（一减便知，精确）——
 *   这是外部"水位检查"的唯一真相，不需要任何攒段/估算。
 *
 *   暂停 = AudioContext.suspend()：时钟冻结，所有已排队的 source 全停；
 *   恢复 = resume() 原地续，无需记 offset / 重建 source。
 *
 * 用法：
 *   player.ensure()          // 手势内建 AudioContext + resume
 *   player.enqueue(f32)      // 入队，自动排时间线
 *   player.buffered()        // 剩余可播秒数
 *   player.pause() / resume()
 *   player.stop()            // 停 + 清所有已调度 source
 *   player.onDrained         // 每次"播到空"回调（外部据此评估收尾）
 */
export class AudioPlayer {
  constructor(sampleRate = 22050) {
    this.defaultSampleRate = sampleRate;
    this.ac = null;
    this.nextStartTime = 0;
    this.active = new Set(); // 已调度（含在播）的 source
    this.playing = false; // stop 后为 false，enqueue 拒收
    this.onDrained = null; // 播到空时回调
  }

  /** 手势内调用：创建（首次）+ 恢复（若被自动策略挂起） */
  ensure() {
    if (!this.ac || this.ac.state === "closed") {
      this.ac = new AudioContext();
      this.nextStartTime = 0;
    }
    if (this.ac.state === "suspended") this.ac.resume().catch(() => {});
    this.playing = true;
    return this.ac;
  }

  /** 剩余可播秒数（精确；未建 ctx / 无内容 = 0） */
  buffered() {
    if (!this.ac) return 0;
    return Math.max(0, this.nextStartTime - this.ac.currentTime);
  }

  /** 有没有还在播/待播的 source */
  hasActive() {
    return this.active.size > 0;
  }

  /** 入队一段 PCM float32，排到时间线上无缝衔接 */
  enqueue(f32, sampleRate = this.defaultSampleRate) {
    if (!this.playing || !this.ac || !f32.length) return;
    const buf = this.ac.createBuffer(1, f32.length, sampleRate);
    buf.getChannelData(0).set(f32);

    const src = this.ac.createBufferSource();
    src.buffer = buf;
    src.connect(this.ac.destination);

    const now = this.ac.currentTime;
    const startAt = Math.max(this.nextStartTime, now); // 前段还在播 → 精确排后面
    src.start(startAt);
    this.nextStartTime = startAt + buf.duration;
    this.active.add(src);

    src.onended = () => {
      this.active.delete(src);
      if (!this.active.size && this.playing) this.onDrained?.();
    };
  }

  pause() {
    if (this.ac?.state === "running") this.ac.suspend();
  }

  resume() {
    if (this.ac?.state === "suspended") this.ac.resume();
  }

  /** 停止 + 清空所有已调度的 source */
  stop() {
    this.playing = false;
    this.nextStartTime = 0;
    for (const src of this.active) {
      try {
        src.stop();
      } catch {}
    }
    this.active.clear();
  }
}

/** 单例，页面级复用 */
export const audioPlayer = new AudioPlayer();
