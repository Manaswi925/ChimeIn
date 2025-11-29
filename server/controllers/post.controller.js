const dayjs = require("dayjs");
const relativeTime = require("dayjs/plugin/relativeTime");
dayjs.extend(relativeTime);
const formatCreatedAt = require("../utils/timeConverter");

const Post = require("../models/post.model");
const Community = require("../models/community.model");
const Comment = require("../models/comment.model");
const User = require("../models/user.model");
const Relationship = require("../models/relationship.model");
const Report = require("../models/report.model");
const PendingPost = require("../models/pendingPost.model");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const moderationRules = require("../moderationRules.json");

/**
 * Helper: remove uploaded file on disk (if present)
 */
const safeUnlink = (filePath) => {
  if (!filePath) return;
  fs.unlink(filePath, (err) => {
    if (err) console.error("Failed to remove file:", filePath, err.message || err);
  });
};

/**
 * Rule-based check using moderationRules.json
 * Checks text against banned words/patterns
 */
const matchesRuleBased = (text) => {
  if (!text) return false;
  const rules = moderationRules.rules || [];
  const lower = text.toLowerCase();

  for (const r of rules) {
    try {
      if (typeof r === "string" && r.startsWith("/") && r.endsWith("/")) {
        const re = new RegExp(r.slice(1, -1), "i");
        if (re.test(text)) return true;
      } else {
        if (lower.includes(String(r).toLowerCase())) return true;
      }
    } catch (e) {
      console.warn("Invalid moderation rule skipped:", r, e.message || e);
    }
  }
  return false;
};

/**
 * AI moderation function (pluggable)
 * Uses Perspective API if configured, otherwise returns safe
 * Returns: { flagged: boolean, reason: string|null, details: object|null }
 */
const aiModerationCheck = async (text) => {
  if (!text) return { flagged: false, reason: null };

  if (process.env.USE_PERSPECTIVE_API === "true" && process.env.PERSPECTIVE_API_KEY) {
    try {
      const body = {
        comment: { text },
        languages: ["en"],
        requestedAttributes: {
          TOXICITY: {},
          SEXUALLY_EXPLICIT: {},
          INSULT: {},
          THREAT: {},
          IDENTITY_ATTACK: {},
        },
      };
      const resp = await fetch(
        `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${process.env.PERSPECTIVE_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          timeout: process.env.CATEGORY_FILTERING_REQUEST_TIMEOUT || 5000,
        }
      );
      if (!resp.ok) {
        console.warn("Perspective API returned non-ok:", resp.status);
        return { flagged: false, reason: null };
      }
      const json = await resp.json();
      const thresholds = {
        TOXICITY: 0.85,
        INSULT: 0.85,
        THREAT: 0.7,
        IDENTITY_ATTACK: 0.8,
        SEXUALLY_EXPLICIT: 0.9,
      };
      for (const attr of Object.keys(json.attributeScores || {})) {
        const score = json.attributeScores[attr].summaryScore.value || 0;
        if (score >= (thresholds[attr] || 0.9)) {
          return {
            flagged: true,
            reason: `${attr} score ${score.toFixed(2)} >= ${thresholds[attr] || 0.9}`,
            details: json,
          };
        }
      }
      return { flagged: false, reason: null, details: json };
    } catch (err) {
      console.warn("Perspective API error:", err.message || err);
      return { flagged: false, reason: null };
    }
  }

  return { flagged: false, reason: null };
};

/**
 * CREATE POST
 * Checks membership, runs moderation, creates post if safe
 */
const createPost = async (req, res) => {
  try {
    const { communityId, content } = req.body;
    const { userId, file, fileUrl, fileType } = req;

    // 1) Membership check
    const community = await Community.findOne({
      _id: { $eq: communityId },
      members: { $eq: userId },
    });

    if (!community) {
      if (file) {
        const filePath = path.join(__dirname, "..", "assets", "userFiles", file.filename);
        safeUnlink(filePath);
      }
      return res.status(401).json({ message: "Unauthorized to post in this community" });
    }

    // 2) Rule-based moderation check
    if (matchesRuleBased(content || "")) {
      if (file) {
        const filePath = path.join(__dirname, "..", "assets", "userFiles", file.filename);
        safeUnlink(filePath);
      }
      return res.status(403).json({ message: "Post blocked by moderation (rule match)" });
    }

    // 3) AI moderation check
    const aiCheck = await aiModerationCheck(content || "");
    if (aiCheck.flagged) {
      if (file) {
        const filePath = path.join(__dirname, "..", "assets", "userFiles", file.filename);
        safeUnlink(filePath);
      }
      return res.status(403).json({
        message: "Post blocked by moderation (AI)",
        reason: aiCheck.reason || "AI flagged the content",
      });
    }

    // 4) Safe - create post
    const newPost = new Post({
      user: userId,
      community: communityId,
      content,
      fileUrl: fileUrl ? fileUrl : null,
      fileType: fileType ? fileType : null,
    });

    const savedPost = await newPost.save();
    const postId = savedPost._id;

    const post = await Post.findById(postId)
      .populate("user", "name avatar")
      .populate("community", "name")
      .lean();

    post.createdAt = dayjs(post.createdAt).fromNow();

    return res.json(post);
  } catch (error) {
    console.error("Error in createPost:", error.message || error);
    return res.status(500).json({ message: "Error creating post" });
  }
};

const confirmPost = async (req, res) => {
  try {
    const { confirmationToken } = req.params;
    const userId = req.userId;
    const pendingPost = await PendingPost.findOne({
      confirmationToken: { $eq: confirmationToken },
      status: "pending",
      user: userId,
    });
    if (!pendingPost) {
      return res.status(404).json({ message: "Post not found" });
    }

    const { user, community, content, fileUrl, fileType } = pendingPost;
    const newPost = new Post({
      user,
      community,
      content,
      fileUrl,
      fileType,
    });

    await PendingPost.findOneAndDelete({
      confirmationToken: { $eq: confirmationToken },
    });
    const savedPost = await newPost.save();
    const postId = savedPost._id;

    const post = await Post.findById(postId)
      .populate("user", "name avatar")
      .populate("community", "name")
      .lean();

    post.createdAt = dayjs(post.createdAt).fromNow();

    res.json(post);
  } catch (error) {
    res.status(500).json({
      message: "Error publishing post",
    });
  }
};

const rejectPost = async (req, res) => {
  try {
    const { confirmationToken } = req.params;
    const userId = req.userId;
    const pendingPost = await PendingPost.findOne({
      confirmationToken: { $eq: confirmationToken },
      status: "pending",
      user: userId,
    });

    if (!pendingPost) {
      return res.status(404).json({ message: "Post not found" });
    }

    await pendingPost.remove();
    res.status(201).json({ message: "Post rejected" });
  } catch (error) {
    res.status(500).json({
      message: "Error rejecting post",
    });
  }
};

const clearPendingPosts = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (user.role !== "moderator") {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const date = new Date();
    date.setHours(date.getHours() - 1);

    await PendingPost.deleteMany({ createdAt: { $lte: date } });

    res.status(200).json({ message: "Pending posts cleared" });
  } catch (error) {
    res.status(500).json({
      message: "Error clearing pending posts",
    });
  }
};

const getPost = async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.userId;

    const post = await findPostById(postId);
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    const comments = await findCommentsByPostId(postId);

    post.comments = formatComments(comments);
    post.dateTime = formatCreatedAt(post.createdAt);
    post.createdAt = dayjs(post.createdAt).fromNow();
    post.savedByCount = await countSavedPosts(postId);

    const report = await findReportByPostAndUser(postId, userId);
    post.isReported = !!report;

    res.status(200).json(post);
  } catch (error) {
    res.status(500).json({
      message: "Error getting post",
    });
  }
};

const findPostById = async (postId) =>
  await Post.findById(postId)
    .populate("user", "name avatar")
    .populate("community", "name")
    .lean();

const findCommentsByPostId = async (postId) =>
  await Comment.find({ post: postId })
    .sort({ createdAt: -1 })
    .populate("user", "name avatar")
    .lean();

const formatComments = (comments) =>
  comments.map((comment) => ({
    ...comment,
    createdAt: dayjs(comment.createdAt).fromNow(),
  }));

const countSavedPosts = async (postId) =>
  await User.countDocuments({ savedPosts: postId });

const findReportByPostAndUser = async (postId, userId) =>
  await Report.findOne({ post: postId, reportedBy: userId });

const getPosts = async (req, res) => {
  try {
    const userId = req.userId;
    const { limit = 10, skip = 0 } = req.query;

    const communities = await Community.find({
      members: userId,
    });

    const communityIds = communities.map((community) => community._id);

    const posts = await Post.find({
      community: {
        $in: communityIds,
      },
    })
      .sort({
        createdAt: -1,
      })
      .populate("user", "name avatar")
      .populate("community", "name")
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .lean();

    const formattedPosts = posts.map((post) => ({
      ...post,
      createdAt: dayjs(post.createdAt).fromNow(),
    }));

    const totalPosts = await Post.countDocuments({
      community: {
        $in: communityIds,
      },
    });

    res.status(200).json({
      formattedPosts,
      totalPosts,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error retrieving posts",
    });
  }
};

const getCommunityPosts = async (req, res) => {
  try {
    const communityId = req.params.communityId;
    const userId = req.userId;

    const { limit = 10, skip = 0 } = req.query;

    const isMember = await Community.findOne({
      _id: communityId,
      members: userId,
    });

    if (!isMember) {
      return res.status(401).json({
        message: "Unauthorized to view posts in this community",
      });
    }

    const posts = await Post.find({
      community: communityId,
    })
      .sort({
        createdAt: -1,
      })
      .populate("user", "name avatar")
      .populate("community", "name")
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .lean();

    const formattedPosts = posts.map((post) => ({
      ...post,
      createdAt: dayjs(post.createdAt).fromNow(),
    }));

    const totalCommunityPosts = await Post.countDocuments({
      community: communityId,
    });

    res.status(200).json({
      formattedPosts,
      totalCommunityPosts,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error retrieving posts",
    });
  }
};

const getFollowingUsersPosts = async (req, res) => {
  try {
    const communityId = req.params.id;
    const userId = req.userId;

    const following = await Relationship.find({
      follower: userId,
    });

    const followingIds = following.map(
      (relationship) => relationship.following
    );

    const posts = await Post.find({
      user: {
        $in: followingIds,
      },
      community: communityId,
    })
      .sort({
        createdAt: -1,
      })
      .populate("user", "name avatar")
      .populate("community", "name")
      .limit(20)
      .lean();

    const formattedPosts = posts.map((post) => ({
      ...post,
      createdAt: dayjs(post.createdAt).fromNow(),
    }));

    res.status(200).json(formattedPosts);
  } catch (error) {
    res.status(500).json({
      message: "Server error",
    });
  }
};

const deletePost = async (req, res) => {
  try {
    const id = req.params.id;
    const post = await Post.findById(id);

    if (!post) {
      return res.status(404).json({
        message: "Post not found. It may have been deleted already",
      });
    }

    await post.remove();
    res.status(200).json({
      message: "Post deleted successfully",
    });
  } catch (error) {
    res.status(404).json({
      message: "An error occurred while deleting the post",
    });
  }
};

const populatePost = async (post) => {
  const savedByCount = await User.countDocuments({
    savedPosts: post._id,
  });

  return {
    ...post.toObject(),
    createdAt: dayjs(post.createdAt).fromNow(),
    savedByCount,
  };
};

const likePost = async (req, res) => {
  try {
    const id = req.params.id;
    const userId = req.userId;
    const updatedPost = await Post.findOneAndUpdate(
      {
        _id: id,
        likes: {
          $ne: userId,
        },
      },
      {
        $addToSet: {
          likes: userId,
        },
      },
      {
        new: true,
      }
    )
      .populate("user", "name avatar")
      .populate("community", "name");

    if (!updatedPost) {
      return res.status(404).json({
        message: "Post not found. It may have been deleted already",
      });
    }

    const formattedPost = await populatePost(updatedPost);

    res.status(200).json(formattedPost);
  } catch (error) {
    res.status(500).json({
      message: "Error liking post",
    });
  }
};

const unlikePost = async (req, res) => {
  try {
    const id = req.params.id;
    const userId = req.userId;

    const updatedPost = await Post.findOneAndUpdate(
      {
        _id: id,
        likes: userId,
      },
      {
        $pull: {
          likes: userId,
        },
      },
      {
        new: true,
      }
    )
      .populate("user", "name avatar")
      .populate("community", "name");

    if (!updatedPost) {
      return res.status(404).json({
        message: "Post not found. It may have been deleted already",
      });
    }

    const formattedPost = await populatePost(updatedPost);

    res.status(200).json(formattedPost);
  } catch (error) {
    res.status(500).json({
      message: "Error unliking post",
    });
  }
};

/**
 * ADD COMMENT with moderation checks
 */
const addComment = async (req, res) => {
  try {
    const { content, postId } = req.body;
    const userId = req.userId;

    // 1) Rule-based moderation check
    if (matchesRuleBased(content || "")) {
      return res.status(403).json({ 
        message: "Comment blocked by moderation (rule match)" 
      });
    }

    // 2) AI moderation check
    const aiCheck = await aiModerationCheck(content || "");
    if (aiCheck.flagged) {
      return res.status(403).json({
        message: "Comment blocked by moderation (AI)",
        reason: aiCheck.reason || "AI flagged the content",
      });
    }

    // 3) Safe to create comment
    const newComment = new Comment({
      user: userId,
      post: postId,
      content,
    });

    await newComment.save();
    await Post.findOneAndUpdate(
      {
        _id: { $eq: postId },
      },
      {
        $addToSet: {
          comments: newComment._id,
        },
      }
    );

    res.status(200).json({
      message: "Comment added successfully",
    });
  } catch (error) {
    res.status(500).json({
      message: "Error adding comment",
    });
  }
};

/**
 * DELETE COMMENT - NEW FUNCTION
 * Allows user to delete their own comment or admin/moderator to delete any
 */
const deleteComment = async (req, res) => {
  try {
    const commentId = req.params.id;
    const userId = req.userId;

    const comment = await Comment.findById(commentId);
    
    if (!comment) {
      return res.status(404).json({
        message: "Comment not found. It may have been deleted already",
      });
    }

    // Check if user is the comment author or admin/moderator
    const user = await User.findById(userId);
    const isAuthor = comment.user.toString() === userId.toString();
    const isAdminOrMod = user && (user.role === "admin" || user.role === "moderator");

    if (!isAuthor && !isAdminOrMod) {
      return res.status(403).json({
        message: "Unauthorized to delete this comment",
      });
    }

    // Remove comment from post's comments array
    await Post.findByIdAndUpdate(comment.post, {
      $pull: { comments: commentId }
    });

    // Delete the comment
    await comment.remove();

    res.status(200).json({
      message: "Comment deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting comment:", error);
    res.status(500).json({
      message: "Error deleting comment",
    });
  }
};

/**
 * CLEANUP OFFENSIVE COMMENTS - ADMIN ONLY
 * Scans all comments and removes those matching moderation rules
 */
const cleanupOffensiveComments = async (req, res) => {
  try {
    const userId = req.userId;
    const user = await User.findById(userId);

    // Only admins can run this
    if (!user || user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const allComments = await Comment.find({});
    let deletedCount = 0;

    for (const comment of allComments) {
      if (matchesRuleBased(comment.content)) {
        // Remove from post's comments array
        await Post.findByIdAndUpdate(comment.post, {
          $pull: { comments: comment._id }
        });
        // Delete comment
        await comment.remove();
        deletedCount++;
      }
    }

    res.status(200).json({
      message: `Cleanup complete. Removed ${deletedCount} offensive comments.`,
      deletedCount,
    });
  } catch (error) {
    console.error("Error cleaning up comments:", error);
    res.status(500).json({
      message: "Error during cleanup",
    });
  }
};

const savePost = async (req, res) => {
  await saveOrUnsavePost(req, res, "$addToSet");
};

const unsavePost = async (req, res) => {
  await saveOrUnsavePost(req, res, "$pull");
};

const saveOrUnsavePost = async (req, res, operation) => {
  try {
    const id = req.params.id;
    const userId = req.userId;

    const update = {};
    update[operation === "$addToSet" ? "$addToSet" : "$pull"] = {
      savedPosts: id,
    };
    const updatedUserPost = await User.findOneAndUpdate(
      {
        _id: userId,
      },
      update,
      {
        new: true,
      }
    )
      .select("savedPosts")
      .populate({
        path: "savedPosts",
        populate: {
          path: "community",
          select: "name",
        },
      });

    if (!updatedUserPost) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const formattedPosts = updatedUserPost.savedPosts.map((post) => ({
      ...post.toObject(),
      createdAt: dayjs(post.createdAt).fromNow(),
    }));

    res.status(200).json(formattedPosts);
  } catch (error) {
    res.status(500).json({
      message: "Server error",
    });
  }
};

const getSavedPosts = async (req, res) => {
  try {
    const userId = req.userId;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const communityIds = await Community.find({ members: userId }).distinct(
      "_id"
    );
    const savedPosts = await Post.find({
      community: { $in: communityIds },
      _id: { $in: user.savedPosts },
    })
      .populate("user", "name avatar")
      .populate("community", "name");

    const formattedPosts = savedPosts.map((post) => ({
      ...post.toObject(),
      createdAt: dayjs(post.createdAt).fromNow(),
    }));

    res.status(200).json(formattedPosts);
  } catch (error) {
    res.status(500).json({
      message: "Server error",
    });
  }
};

const getPublicPosts = async (req, res) => {
  try {
    const publicUserId = req.params.publicUserId;
    const currentUserId = req.userId;

    const isFollowing = await Relationship.exists({
      follower: currentUserId,
      following: publicUserId,
    });
    if (!isFollowing) {
      return null;
    }

    const commonCommunityIds = await Community.find({
      members: { $all: [currentUserId, publicUserId] },
    }).distinct("_id");

    const publicPosts = await Post.find({
      community: { $in: commonCommunityIds },
      user: publicUserId,
    })
      .populate("user", "_id name avatar")
      .populate("community", "_id name")
      .sort("-createdAt")
      .limit(10)
      .exec();

    const formattedPosts = publicPosts.map((post) => ({
      ...post.toObject(),
      createdAt: dayjs(post.createdAt).fromNow(),
    }));

    res.status(200).json(formattedPosts);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  getPost,
  getPosts,
  createPost,
  getCommunityPosts,
  deletePost,
  rejectPost,
  clearPendingPosts,
  confirmPost,
  likePost,
  unlikePost,
  addComment,
  deleteComment,  // NEW
  cleanupOffensiveComments,  // NEW
  savePost,
  unsavePost,
  getSavedPosts,
  getPublicPosts,
  getFollowingUsersPosts,
};