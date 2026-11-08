const mongoose = require("mongoose");

const uploadedDocumentSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    index: true
  },
  userId: {
    type: String,
    required: true,
    index: true
  },
  filename: {
    type: String,
    required: true
  },
  originalFilename: {
    type: String,
    required: true
  },
  extractedText: {
    type: String,
    required: true
  },
  summary: {
    type: String, // AI-generated summary for efficient context
    default: null
  },
  fileType: {
    type: String,
    required: true
  },
  fileSize: {
    type: Number,
    required: true
  },
  documentType: {
    type: String, // employment_contract, policy, etc.
    default: 'unknown'
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // Only for long documents: their text in ~1,000-character chunks with embeddings,
  // so questions can retrieve the relevant sections. Deleted with the document.
  chunks: [
    {
      _id: false,
      text: { type: String, required: true },
      embedding: { type: [Number], required: true },
    },
  ],
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Compound index for efficient session-based queries
uploadedDocumentSchema.index({ sessionId: 1, userId: 1, isActive: 1 });

// Auto-delete documents after 24 hours
uploadedDocumentSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model("UploadedDocument", uploadedDocumentSchema);