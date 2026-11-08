// routes/chat.routes.js (MODIFIED - added file upload support)
const express = require("express");
const Message = require("../models/chat");
const UploadedDocument = require("../models/uploadDocument");
const { v4: uuidv4 } = require("uuid");
const { HumanMessage, AIMessage } = require("@langchain/core/messages");
const authenticateToken = require("../middlewares/authMiddleware");
const { legalChat } = require("../services/chat.service");

// *** NEW IMPORTS ***
const multer = require("multer");
const { processUploadedDocument } = require("../services/document.service");

const router = express.Router();

// *** NEW: Configure multer for file uploads ***
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 5, // Allow up to 5 files per request
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [".pdf", ".doc", ".docx", ".txt"];
    const fileExtension =
      "." + file.originalname.split(".").pop().toLowerCase();

    if (allowedTypes.includes(fileExtension)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Unsupported file type: ${fileExtension}. Allowed: ${allowedTypes.join(
            ", "
          )}`
        ),
        false
      );
    }
  },
});

// Multer rejects bad uploads before the route handler runs, so its errors
// must be converted here; the frontend toasts `error`.
const uploadDocuments = (req, res, next) => {
  upload.array("documents", 5)(req, res, (err) => {
    if (!err) return next();

    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Files must be under 10MB each" });
    }
    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({ error: "Maximum 5 files per request" });
    }
    if (err.message?.includes("Unsupported file type")) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  });
};

router.post(
  "/",
  authenticateToken,
  uploadDocuments,
  async (req, res) => {
    let pastMessages = [];
    let chat = [];

    try {
      let { msg, sessionId } = req.body;
      let user = req.user;
      const userId = user?.id;
      const uploadedFiles = req.files || [];

      console.log(
        `Chat request - Files: ${uploadedFiles.length}, Message: "${
          msg || "none"
        }"`
      );

      if (!sessionId) {
        sessionId = uuidv4();
      }

      // *** PROCESS UPLOADED FILES ***
      const processedDocuments = [];
      const irrelevantDocuments = [];
      let hasValidDocuments = false;
      let hasTechnicalErrors = false;

      if (uploadedFiles.length > 0) {
        console.log(`Processing ${uploadedFiles.length} uploaded files...`);

        for (const file of uploadedFiles) {
          try {
            const docResult = await processUploadedDocument({
              buffer: file.buffer,
              filename: file.originalname,
              sessionId,
              userId,
            });

            hasValidDocuments = true;
            processedDocuments.push({
              filename: file.originalname,
              processed: true,
              irrelevant: false,
              documentType: docResult.documentType,
              error: null,
            });

            console.log(
              `Processed: ${file.originalname} -> ${docResult.documentType}`
            );
          } catch (docError) {
            console.error(
              `Failed to process ${file.originalname}:`,
              docError.message
            );

            if (
              docError.message.includes(
                "doesn't appear to be related to UK legal matters"
              )
            ) {
              console.log(
                `Document marked as irrelevant: ${file.originalname}`
              );

              irrelevantDocuments.push({
                filename: file.originalname,
                reason: "not related to UK legal matters",
              });

              processedDocuments.push({
                filename: file.originalname,
                processed: false,
                irrelevant: true,
                documentType: null,
                error: "Document not related to UK legal matters",
              });
            } else {
              console.error(
                ` Technical error processing ${file.originalname}:`,
                docError.message
              );

              hasTechnicalErrors = true;
              processedDocuments.push({
                filename: file.originalname,
                processed: false,
                irrelevant: false,
                documentType: null,
                error: docError.message,
              });
            }
          }
        }
      }

      let enhancedMessage = msg?.trim() || "";

      if (!enhancedMessage && uploadedFiles.length === 0) {
        return res.status(400).json({
          error: "No input provided",
          message: "Please provide a message or upload documents",
        });
      }

      if (hasTechnicalErrors && !hasValidDocuments && !enhancedMessage) {
        const technicalErrors = processedDocuments.filter(
          (doc) => !doc.processed && !doc.irrelevant
        );

        return res.status(400).json({
          error: "Document processing failed",
          message: "Technical errors occurred while processing documents.",
          uploadResults: technicalErrors,
        });
      }

      console.log(
        `Proceeding with chat - Valid docs: ${hasValidDocuments}, Message: ${!!enhancedMessage}, Irrelevant: ${
          irrelevantDocuments.length
        }`
      );

      // Get chat history (FIXED: Sort by createdAt ascending)
      const query = { sessionId, userId };
      chat = await Message.find(query).sort({ createdAt: 1 });
      if (chat?.length > 0) {
        pastMessages = chat.map((message) => {
          if (message.type === "AI") {
            return new AIMessage(message.msg);
          } else {
            return new HumanMessage(message.msg);
          }
        });
      }

      if (!enhancedMessage) {
        if (hasValidDocuments) {
          enhancedMessage =
            "Please analyze the uploaded legal documents and provide key insights.";
        } else if (irrelevantDocuments.length > 0) {
          enhancedMessage =
            "I received documents that don't appear to be related to UK legal matters. Please upload UK legal documents or ask me a legal question.";
        }
      }

      const response = await legalChat({
        userInput: enhancedMessage,
        sessionId,
        pastMessages,
        userId,
        hasValidDocuments,
        irrelevantDocuments,
        userMessageProvided: !!msg?.trim(),
      });

      // *** SAVE MESSAGES TO DATABASE ***
      const documentNames = uploadedFiles.map((f) => f.originalname);

      const newMessage = new Message({
        msg: msg?.trim() || "Document uploaded for analysis",
        sessionId,
        userId,
        type: "Human",
        hasDocuments: uploadedFiles.length > 0,
        documentNames: documentNames,
        documentCount: uploadedFiles.length,
        documentResults: processedDocuments,
        irrelevantCount: irrelevantDocuments.length,
        processedCount: processedDocuments.filter((d) => d.processed).length,
      });
      const savedUserMessage = await newMessage.save();

      const messageAI = new Message({
        msg: response.text,
        sessionId,
        userId,
        type: "AI",
        hasDocuments: uploadedFiles.length > 0,
        documentNames: documentNames,
        documentCount: uploadedFiles.length,
        documentResults: processedDocuments,
        irrelevantCount: irrelevantDocuments.length,
        processedCount: processedDocuments.filter((d) => d.processed).length,
      });
      const savedAIMessage = await messageAI.save();

      // *** RETURN DATABASE OBJECTS DIRECTLY ***
      const responseData = {
        // New structure matching database schema
        userMessage: savedUserMessage.toObject(),
        aiMessage: savedAIMessage.toObject(),

        // Keep existing fields for backward compatibility
        msg: response.text,
        sessionId,
        userId,
        sources: response.sources || [],
        fromFallback: response.fallback || false,
        confidence: response.confidence,
        documentsProcessed: processedDocuments.filter((d) => d.processed)
          .length,
        documentsUploaded: uploadedFiles.length,
        irrelevantDocuments: irrelevantDocuments.length,
        technicalErrors: processedDocuments.filter(
          (d) => !d.processed && !d.irrelevant
        ).length,
        documentContext: response.documentContext === true, // the answer used the documents
        sessionHasDocuments: response.sessionHasDocuments === true,
        documentsAvailable: response.documentsAvailable || 0,
        uploadResults:
          uploadedFiles.length > 0 ? processedDocuments : undefined,
      };

      res.status(201).json(responseData);
    } catch (err) {
      console.error("Chat route error:", err);
      res.status(500).json({ error: "Internal server error: " + err.message });
    }
  }
);
// *** NEW: Route to get uploaded documents for a session ***
router.get("/documents/:sessionId", authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: "User authentication required" });
    }

    const { getSessionDocuments } = require("../services/document.service");
    const documents = await getSessionDocuments(sessionId, userId);

    res.json({
      sessionId,
      totalDocuments: documents.length,
      documents: documents.map((doc) => ({
        id: doc.id,
        filename: doc.filename,
        documentType: doc.documentType,
        summary: doc.summary,
        wordCount: doc.wordCount,
        uploadedAt: doc.uploadedAt,
      })),
    });
  } catch (err) {
    console.error("Error fetching documents:", err);
    res.status(500).json({ error: err.message });
  }
});

// *** NEW: Route to delete a specific document ***
router.delete("/documents/:documentId", authenticateToken, async (req, res) => {
  try {
    const { documentId } = req.params;
    const userId = req.user?.id;

    const document = await UploadedDocument.findOneAndUpdate(
      { _id: documentId, userId },
      { isActive: false },
      { new: true }
    );

    if (!document) {
      return res.status(404).json({ error: "Document not found" });
    }

    res.json({
      success: true,
      message: `Document ${document.originalFilename} removed from session`,
    });
  } catch (err) {
    console.error("Error deleting document:", err);
    res.status(500).json({ error: err.message });
  }
});

// EXISTING ROUTES (UNCHANGED)
router.get("/", authenticateToken, async (req, res) => {
  const { sessionId = null } = req.query;
  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }
  let user = req.user;
  const userId = user?.id;
  const query = { sessionId, userId };

  try {
    const messages = await Message.find(query).sort({ createdAt: 1 });
    res.status(200).json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/list", authenticateToken, async (req, res) => {
  try {
    let user = req.user;
    const userId = user?.id;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const sessionIds = await Message.distinct("sessionId", { userId });

    if (sessionIds.length > 0) {
      const messages = await Message.aggregate([
        {
          $match: { userId, sessionId: { $in: sessionIds } },
        },
        {
          $sort: { sessionId: 1, createdAt: 1 },
        },
        {
          $group: {
            _id: "$sessionId",
            firstMessage: { $first: "$$ROOT" },
          },
        },
        {
          $replaceRoot: { newRoot: "$firstMessage" },
        },
        {
          $sort: { createdAt: -1 },
        },
      ]);

      res.status(200).json(messages);
    } else {
      res.status(200).json([]);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const message = await Message.findOne({
      _id: req.params.id,
      userId: req.user?.id,
    });
    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }
    res.status(200).json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a whole chat: all of the caller's messages and uploaded documents in it
router.delete("/session/:sessionId", authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user?.id;

    const [messages, documents] = await Promise.all([
      Message.deleteMany({ sessionId, userId }),
      UploadedDocument.deleteMany({ sessionId, userId }),
    ]);

    if (messages.deletedCount === 0 && documents.deletedCount === 0) {
      return res.status(404).json({ error: "Chat not found" });
    }

    res.status(200).json({
      success: true,
      deletedMessages: messages.deletedCount,
      deletedDocuments: documents.deletedCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A question and its answer are saved together, so they are deleted together
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id;
    const message = await Message.findOne({ _id: req.params.id, userId });
    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    const sameChat = {
      sessionId: message.sessionId,
      userId,
      _id: { $ne: message._id },
    };
    const partner =
      message.type === "Human"
        ? await Message.findOne({ ...sameChat, createdAt: { $gte: message.createdAt } }).sort({ createdAt: 1 })
        : await Message.findOne({ ...sameChat, createdAt: { $lte: message.createdAt } }).sort({ createdAt: -1 });

    const ids = [message._id];
    if (partner && partner.type !== message.type) ids.push(partner._id);

    const { deletedCount } = await Message.deleteMany({ _id: { $in: ids }, userId });
    res.status(200).json({ message: "Message deleted successfully", deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
