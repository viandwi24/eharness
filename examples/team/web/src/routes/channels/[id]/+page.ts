import { redirect } from '@sveltejs/kit';
// `/channels/<id>` is the overview
export const load = ({ params }: { params: { id: string } }): never => {
	redirect(307, `/channels/${encodeURIComponent(params.id)}/overview`);
};
