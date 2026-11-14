import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="py-10 text-center">
      <p className="text-[15px] font-semibold text-t1">No such screen</p>
      <Link to="/overview" className="mt-2 inline-block text-[13px] text-t2 underline underline-offset-[3px]">
        Go to Overview
      </Link>
    </div>
  );
}
