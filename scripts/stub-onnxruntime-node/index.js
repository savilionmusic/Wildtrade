module.exports = {
  InferenceSession: class {
    static async create() { return new this(); }
    async run() { return {}; }
  },
  Tensor: class {
    constructor() {}
  }
};