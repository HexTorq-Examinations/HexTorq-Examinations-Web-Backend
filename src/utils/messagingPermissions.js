// Hierarchy rules for who may START a direct conversation with whom.
// Once a conversation exists, any of its participants may reply — this is what
// lets a Student reply to a Super Admin/Admin who messaged first, while a Student
// can never be the one to initiate contact with staff.
//
//   SUPER_ADMIN -> anyone
//   ADMIN       -> SUPER_ADMIN (any), ADMIN (same org), STUDENT (same org)
//   STUDENT     -> STUDENT only, same Class ("classmates")
//
// `sender`/`recipient` are full User rows (with studentProfile included when role
// is STUDENT) — org scoping and classId equality are read off them directly.
function canInitiateDirect(sender, recipient) {
  if (!sender || !recipient || sender.id === recipient.id) return false;

  if (sender.role === 'SUPER_ADMIN') return true;

  if (sender.role === 'ADMIN') {
    if (recipient.role === 'SUPER_ADMIN') return true;
    if (recipient.role === 'ADMIN' || recipient.role === 'STUDENT') {
      return !!sender.organizationId && sender.organizationId === recipient.organizationId;
    }
    return false;
  }

  if (sender.role === 'STUDENT') {
    if (recipient.role !== 'STUDENT') return false;
    if (!sender.organizationId || sender.organizationId !== recipient.organizationId) return false;
    const a = sender.studentProfile;
    const b = recipient.studentProfile;
    if (!a || !b) return false;
    return a.classId === b.classId;
  }

  return false;
}

// Who is allowed to be added to a GROUP conversation being created by `creator`.
// A group's membership eligibility mirrors what the creator could otherwise
// direct-message — a Student can never create a group at all (enforced separately
// in the route/controller), so this only ever runs for ADMIN/SUPER_ADMIN creators.
function canAddToGroup(creator, member) {
  return canInitiateDirect(creator, member);
}

module.exports = { canInitiateDirect, canAddToGroup };
