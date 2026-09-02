"use client";

import { useCallback, useEffect, useRef, useState } from 'react';

export function useWebcam() {
  const streamRef = useRef(null);
  const videoTrackRef = useRef(null);
  const audioTrackRef = useRef(null);
  const [stream, setStream] = useState(null);
  const [isEnabled, setIsEnabled] = useState(false);
  const [isAudioEnabled, setIsAudioEnabled] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isAudioStarting, setIsAudioStarting] = useState(false);
  const [error, setError] = useState(null);

  const publishStream = useCallback(() => {
    const tracks = [videoTrackRef.current, audioTrackRef.current].filter((track) => (
      track && track.readyState !== 'ended'
    ));
    const nextStream = tracks.length > 0 ? new MediaStream(tracks) : null;

    streamRef.current = nextStream;
    setStream(nextStream);
    setIsEnabled(Boolean(videoTrackRef.current && videoTrackRef.current.readyState !== 'ended'));
    setIsAudioEnabled(Boolean(audioTrackRef.current && audioTrackRef.current.readyState !== 'ended'));
  }, []);

  const stopVideo = useCallback(() => {
    videoTrackRef.current?.stop();
    videoTrackRef.current = null;
    setIsStarting(false);
    publishStream();
  }, [publishStream]);

  const stopAudio = useCallback(() => {
    audioTrackRef.current?.stop();
    audioTrackRef.current = null;
    setIsAudioStarting(false);
    publishStream();
  }, [publishStream]);

  const stop = useCallback(() => {
    videoTrackRef.current?.stop();
    audioTrackRef.current?.stop();
    videoTrackRef.current = null;
    audioTrackRef.current = null;
    setIsStarting(false);
    setIsAudioStarting(false);
    publishStream();
  }, [publishStream]);

  const start = useCallback(async () => {
    if (videoTrackRef.current || isStarting) return streamRef.current;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      const nextError = new Error('Webcam is not available in this browser');
      setError(nextError);
      return null;
    }

    setIsStarting(true);
    setError(null);

    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
        },
      });
      const [videoTrack] = nextStream.getVideoTracks();

      if (!videoTrack) {
        throw new Error('No webcam video track was returned');
      }

      videoTrack.addEventListener('ended', () => {
        if (videoTrackRef.current === videoTrack) {
          videoTrackRef.current = null;
          publishStream();
        }
      }, { once: true });

      videoTrackRef.current = videoTrack;
      publishStream();
      return streamRef.current;
    } catch (nextError) {
      setError(nextError);
      return null;
    } finally {
      setIsStarting(false);
    }
  }, [isStarting, publishStream]);

  const startAudio = useCallback(async () => {
    if (audioTrackRef.current || isAudioStarting) return streamRef.current;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      const nextError = new Error('Microphone is not available in this browser');
      setError(nextError);
      return null;
    }

    setIsAudioStarting(true);
    setError(null);

    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      const [audioTrack] = nextStream.getAudioTracks();

      if (!audioTrack) {
        throw new Error('No microphone audio track was returned');
      }

      audioTrack.addEventListener('ended', () => {
        if (audioTrackRef.current === audioTrack) {
          audioTrackRef.current = null;
          publishStream();
        }
      }, { once: true });

      audioTrackRef.current = audioTrack;
      publishStream();
      return streamRef.current;
    } catch (nextError) {
      setError(nextError);
      return null;
    } finally {
      setIsAudioStarting(false);
    }
  }, [isAudioStarting, publishStream]);

  const toggle = useCallback(() => {
    if (videoTrackRef.current) {
      stopVideo();
      return;
    }

    void start();
  }, [start, stopVideo]);

  const toggleAudio = useCallback(() => {
    if (audioTrackRef.current) {
      stopAudio();
      return;
    }

    void startAudio();
  }, [startAudio, stopAudio]);

  useEffect(() => stop, [stop]);

  return {
    stream,
    isEnabled,
    isAudioEnabled,
    isStarting,
    isAudioStarting,
    error,
    start,
    startAudio,
    stop,
    stopAudio,
    toggle,
    toggleAudio,
  };
}
