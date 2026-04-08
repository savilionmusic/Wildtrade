class RTCPeerConnection {}
class RTCSessionDescription {}
class RTCIceCandidate {}
class MediaStream {}

const mediaDevices = {
  async getUserMedia() {
    throw new Error('WebRTC is disabled in Wildtrade runtime.');
  },
};

const nonstandard = {};

const api = {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  MediaStream,
  mediaDevices,
  nonstandard,
};

module.exports = api;
module.exports.default = api;
