import { useLocation } from "react-router-dom";
import { useEffect } from "react";
import { clearPostAction, getPostAction } from "../redux/actions/postActions";
import { useSelector, useDispatch } from "react-redux";
import CommonLoading from "../components/loader/CommonLoading";
import ViewReportedPost from "../components/moderator/ViewReportedPost";
import CommentSidebar from "../components/post/CommentSidebar";

const ReportedPost = () => {
  const location = useLocation();
  const dispatch = useDispatch();
  const postId = location.state.postId;

  const userData = useSelector((state) => state.auth?.userData);

  useEffect(() => {
    dispatch(getPostAction(postId));
    return () => {
      dispatch(clearPostAction());
    };
  }, [dispatch, postId]);

  const post = useSelector((state) => state.posts?.post);

  // Handler to refresh post after comment deletion
  const handleCommentDeleted = () => {
    dispatch(getPostAction(postId));
  };

  if (!post)
    return (
      <div className="col-span-3 flex h-screen items-center justify-center">
        <CommonLoading />
      </div>
    );

  return (
    <>
      <div className="main-section">
        <ViewReportedPost post={post} />
      </div>

      <CommentSidebar 
        comments={post.comments}
        currentUserId={userData?._id}
        onCommentDeleted={handleCommentDeleted}
      />
    </>
  );
};

export default ReportedPost;