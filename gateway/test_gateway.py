import unittest
from unittest.mock import patch, MagicMock
import requests
import server

class GatewayTests(unittest.TestCase):
    nonce='12345678-1234-1234-1234-123456789abc'
    def session(self, data):
        session=MagicMock()
        response=session.get.return_value
        response.status_code=200
        response.json.return_value=data
        return session
    def test_socks_only_and_echo(self):
        session=self.session({'origin':'203.0.113.42','url':server.TARGET+self.nonce})
        with patch('server.requests.Session') as cls:
            cls.return_value.__enter__.return_value=session
            result=server.measure(self.nonce)
        self.assertEqual(result['ip'],'203.0.113.42')
        self.assertFalse(session.trust_env)
        self.assertEqual(session.get.call_args.kwargs['proxies'], {'http':server.SOCKS_URL,'https':server.SOCKS_URL})
        self.assertFalse(session.get.call_args.kwargs['allow_redirects'])
    def test_rejects_wrong_echo(self):
        session=self.session({'origin':'203.0.113.42','url':server.TARGET+'wrong'})
        with patch('server.requests.Session') as cls:
            cls.return_value.__enter__.return_value=session
            with self.assertRaises(ValueError): server.measure(self.nonce)
    def test_no_fallback_after_proxy_failure(self):
        session=MagicMock();session.get.side_effect=requests.ConnectionError('proxy down')
        with patch('server.requests.Session') as cls:
            cls.return_value.__enter__.return_value=session
            with self.assertRaises(requests.ConnectionError):server.measure(self.nonce)
        self.assertEqual(session.get.call_count,1)
    def test_rejects_forwarding_chain(self):
        session=self.session({'origin':'203.0.113.42, 192.0.2.1','url':server.TARGET+self.nonce})
        with patch('server.requests.Session') as cls:
            cls.return_value.__enter__.return_value=session
            with self.assertRaises(ValueError):server.measure(self.nonce)
if __name__=='__main__':unittest.main()
