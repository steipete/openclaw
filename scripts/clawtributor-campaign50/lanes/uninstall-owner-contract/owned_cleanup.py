"""Remove registered proof trees; handle only Windows readonly regular-file unlink errors."""
import os
from pathlib import Path
import shutil
import stat


def remove_owned_tree(target, owned_root):
    root = Path(os.path.abspath(owned_root))
    tree = Path(os.path.abspath(target))
    root_info = root.lstat()
    tree_info = tree.lstat()
    reparse = getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0)
    for path, info in [(root, root_info), (tree, tree_info)]:
        if not stat.S_ISDIR(info.st_mode) or getattr(info, 'st_file_attributes', 0) & reparse:
            raise RuntimeError('cleanup requires an owned regular directory: ' + str(path))
    if not tree.is_relative_to(root) or tree.resolve() != tree or root.resolve() != root:
        raise RuntimeError('cleanup tree is outside the registered root or passes through an alias')
    root_identity = (root_info.st_dev, root_info.st_ino)

    def onexc(function, failed_path, error):
        if (
            os.name != 'nt'
            or function is not os.unlink
            or not isinstance(error, PermissionError)
            or getattr(error, 'winerror', None) != 5
        ):
            raise error
        candidate = Path(os.path.abspath(failed_path))
        if (
            candidate == tree
            or not candidate.is_relative_to(tree)
            or not candidate.parent.resolve().is_relative_to(tree)
        ):
            raise error
        current_root = root.lstat()
        if (current_root.st_dev, current_root.st_ino) != root_identity:
            raise error
        before = candidate.lstat()
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT
            or not before.st_file_attributes & stat.FILE_ATTRIBUTE_READONLY
        ):
            raise error
        # Only this known readonly regular file changes; ACLs, directories and other errors stay untouched.
        os.chmod(candidate, stat.S_IMODE(before.st_mode) | stat.S_IWRITE)
        after = candidate.lstat()
        if (
            (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino)
            or not stat.S_ISREG(after.st_mode)
            or after.st_nlink != 1
            or after.st_file_attributes & (stat.FILE_ATTRIBUTE_REPARSE_POINT | stat.FILE_ATTRIBUTE_READONLY)
        ):
            raise error
        function(candidate)

    if os.name == 'nt':
        shutil.rmtree(tree, onexc=onexc)
    else:
        shutil.rmtree(tree)
